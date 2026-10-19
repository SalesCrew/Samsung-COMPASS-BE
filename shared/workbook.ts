import { unzipSync } from 'fflate';
import type { ExcelCell, SheetPreview } from './admin.ts';

const xml = (source: string) => {
  const doc = new DOMParser().parseFromString(source, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('Ungültige Excel-XML-Struktur.');
  return doc;
};
const elements = (parent: Element | Document, name: string) => Array.from(parent.getElementsByTagName('*')).filter(el => el.localName === name);
export const isPivotSheet = (name: string) => name.replace(/[\s_-]/g, '').toLowerCase() === 'pivotliste';
export const preferredSheet = (sheets: SheetPreview[]) => sheets.find(sheet => isPivotSheet(sheet.name)) ?? sheets[0];
const columnNumber = (name: string) => [...name].reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0);
const columnName = (index: number) => {
  let name = '';
  for (let value = index; value > 0; value = Math.floor((value - 1) / 26)) name = String.fromCharCode(65 + (value - 1) % 26) + name;
  return name;
};

/** Read saved cell values only. Never execute formulas, VBA or external links. */
export async function inspectWorkbook(file: File): Promise<SheetPreview[]> {
  if (!/\.(xlsx|xlsm)$/i.test(file.name)) throw new Error('Bitte .xlsx oder .xlsm wählen.');
  if (file.size > 30 * 1024 * 1024) throw new Error('Dateien dürfen höchstens 30 MB groß sein.');
  const archive = unzipSync(new Uint8Array(await file.arrayBuffer()));
  const read = (path: string) => new TextDecoder().decode(archive[path] ?? new Uint8Array());
  if (!archive['xl/workbook.xml']) throw new Error('Kein gültiges Excel-Workbook gefunden.');
  const workbook = xml(read('xl/workbook.xml'));
  const date1904 = ['1', 'true'].includes(elements(workbook, 'workbookPr')[0]?.getAttribute('date1904') ?? '');
  const targets = new Map(elements(xml(read('xl/_rels/workbook.xml.rels')), 'Relationship').map(rel => [rel.getAttribute('Id'), rel.getAttribute('Target') ?? '']));
  const strings = archive['xl/sharedStrings.xml'] ? elements(xml(read('xl/sharedStrings.xml')), 'si').map(si => elements(si, 't').map(t => t.textContent ?? '').join('')) : [];
  const cellValue = (cell: Element): ExcelCell => {
    const raw = elements(cell, 'v')[0]?.textContent;
    const type = cell.getAttribute('t');
    if (type === 'e') return { kind: 'error', value: raw ?? '#ERROR!' };
    if (elements(cell, 'f').length && raw == null) return { kind: 'uncached-formula', value: null };
    if (type === 'inlineStr') return { kind: 'value', value: elements(cell, 't').map(t => t.textContent ?? '').join('') };
    if (raw == null || raw === '') return { kind: 'blank', value: null };
    if (type === 's') return { kind: 'value', value: strings[Number(raw)] ?? '' };
    if (type === 'b') return { kind: 'value', value: raw === '1' };
    if (type === 'str' || type === 'd') return { kind: 'value', value: raw };
    const number = Number(raw);
    return { kind: 'value', value: Number.isFinite(number) ? number : raw };
  };
  return elements(workbook, 'sheet').map((sheet, index) => {
    const name = sheet.getAttribute('name') ?? `Sheet ${index + 1}`;
    const target = targets.get(sheet.getAttribute('r:id')) ?? `worksheets/sheet${index + 1}.xml`;
    const path = new URL(target, 'https://workbook.local/xl/').pathname.slice(1);
    if (!archive[path]) throw new Error(`Arbeitsblatt „${name}“ fehlt in der Datei.`);
    const doc = xml(read(path));
    const data = elements(doc, 'row').map(row => ({
      row: Number(row.getAttribute('r')),
      cells: Object.fromEntries(elements(row, 'c').map(cell => [cell.getAttribute('r')?.match(/^[A-Z]+/)?.[0] ?? '', cellValue(cell)])),
    }));
    const dimension = elements(doc, 'dimension')[0]?.getAttribute('ref') ?? '—';
    const pivot = isPivotSheet(name);
    const headerRow = pivot ? 2 : 1;
    const header = data.find(row => row.row === headerRow)?.cells ?? {};
    const top = data.find(row => row.row === 1)?.cells ?? {};
    const headingRows = data.filter(row => row.row <= (pivot ? 2 : 5));
    const maxColumn = pivot ? Math.max(1, ...Object.keys(header).filter(key => header[key].value != null && header[key].value !== '').map(columnNumber))
      : Math.min(256, columnNumber(dimension.match(/:([A-Z]+)\d+$/)?.[1] ?? 'A'));
    let section = '';
    const columns = Array.from({ length: maxColumn }, (_, offset) => {
      const key = columnName(offset + 1);
      if (top[key]?.value) section = String(top[key].value);
      const pieces = headingRows.map(row => String(row.cells[key]?.value ?? '').trim()).filter(value => value && !/^[-+]?\d+(?:[.,]\d+)?%?$/.test(value));
      return { key, label: pivot ? String(header[key]?.value ?? '') : `${key} · ${[...new Set(pieces)].slice(0, 3).join(' / ') || 'ohne Überschrift'}`, section: pivot ? section : undefined };
    });
    return { name, dimension, columns, rows: data.length, headerRow, date1904, data: pivot ? data.filter(row => row.row > headerRow) : undefined };
  });
}
