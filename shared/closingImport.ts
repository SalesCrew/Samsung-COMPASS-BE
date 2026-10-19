import headers from './closingSourceHeaders.json' with { type: 'json' };
import type { AdminMetric, ColumnDataType, ExcelCell, ImportDatasetId, SheetPreview, SourceColumnMapping } from './admin.ts';
import type { SECGroup } from './groups.ts';
import { isPivotSheet } from './workbook.ts';

type Group = SECGroup['id'];
export type ClosingDefinition = { id: string; column: string; label: string; section: string; field: string; dataset: ImportDatasetId; dataType: ColumnDataType; required: boolean; active: boolean };
const normalize = (value: string) => value.toLowerCase().replace(/\s+/g, ' ').trim();
const slug = (value: string) => normalize(value).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const personal: Record<string, [ImportDatasetId, string, ColumnDataType]> = {
  'SEC+Shop ID': ['assignment', 'assignment.sourceShopId', 'text'], 'SEC ID': ['identity', 'person.externalId', 'text'],
  Name: ['identity', 'person.name', 'text'], Markt: ['assignment', 'assignment.market', 'text'],
  'Markt + Anstellung': ['assignment', 'assignment.sourceLabel', 'text'], Supervisor: ['assignment', 'assignment.supervisor', 'text'],
  Abteilung: ['assignment', 'assignment.department', 'text'], Stunden: ['assignment', 'assignment.hoursRaw', 'text'],
  Anstellung: ['assignment', 'assignment.employment', 'text'], Gehalt: ['premium', 'premium.salary', 'currency'],
  'Faktor Bonus': ['premium', 'premium.factor', 'number'], Kommentar: ['assignment', 'assignment.comment', 'text'],
  Monat: ['snapshot', 'snapshot.reportMonth', 'date'],
};
const kpis: Record<Group, Record<string, string>> = {
  DA: { Y: 'laundry', Z: 'ref', AA: 'vc-stick', AB: 'vc-premium', AC: 'vc-stretch' },
  HE: { Y: 'units', Z: 'soundbar', AA: 'asp', AB: 'share' },
  IM: { AA: 'flagship', AB: 'a-series', AC: 'hhp-asp', AD: 'wear', AE: 'tablet', AF: 'accessories' },
  LH: { X: 'he-units', Y: 'he-soundbar', Z: 'he-asp', AA: 'he-share', AH: 'im-flagship', AI: 'im-a-series', AJ: 'im-hhp-asp', AK: 'im-wear', AL: 'im-tablet', AM: 'im-accessories' },
  ST: {},
};

/** Header-only reference extracted from Marlene's five August 2026 workbooks. */
export function closingDefinitions(group: Group, metrics: AdminMetric[] = []): ClosingDefinition[] {
  const original = headers[group].map(source => {
    let [dataset, field, dataType]: [ImportDatasetId, string, ColumnDataType] = personal[source.label] ?? ['softbonus', `softbonus.${slug(source.label)}`, 'percent'];
    if (!personal[source.label]) {
      if (kpis[group][source.column]) [dataset, field, dataType] = ['sellout', `${kpis[group][source.column]}.achievement`, 'percent'];
      else if (source.label === 'Softbonus') field = 'softbonus.overall';
      else if (/^max\. Bonus$/.test(source.label)) [dataset, field, dataType] = ['premium', 'premium.maximum', 'currency'];
      else if (/^ach\. Bonus$/.test(source.label)) [dataset, field, dataType] = ['premium', 'premium.achieved', 'currency'];
      else if (/Sales Race/.test(source.label)) [dataset, field, dataType] = ['premium', 'premium.salesRace', 'currency'];
      else if (/On Top/.test(source.label)) [dataset, field, dataType] = ['premium', 'premium.onTop', 'currency'];
      else if (/Avg\./.test(source.label)) [dataset, field, dataType] = ['premium', 'premium.previousAverage', 'currency'];
      else if (source.label === 'ZE aliq') [dataset, field, dataType] = ['premium', 'premium.aliquotAchievement', 'percent'];
      else if (source.label === 'Kategorie') [dataset, field, dataType] = ['annual', 'annual.monthPoints', 'number'];
      else if (source.label === 'Kategorie Name') [dataset, field, dataType] = ['annual', 'annual.monthCategory', 'text'];
      else if (source.label === 'SEC Level') [dataset, field, dataType] = ['annual', 'annual.sourceLevel', 'text'];
      else if (/Sellout/.test(source.label)) [dataset, field, dataType] = ['sellout', source.label === 'Sellout' ? 'sellout.overall' : `sellout.${slug(source.label)}`, 'percent'];
    }
    const active = source.label !== 'Gehalt' && !/^Avg\./.test(source.label) && !(group === 'ST' && (/Sellout|TGT/.test(source.label)));
    return { ...source, id: `${group}:${source.column}`, dataset, field, dataType, required: ['SEC ID', 'Markt', 'Monat'].includes(source.label), active };
  });
  const fields = new Set(original.map(item => item.field));
  const extra = metrics.filter(metric => metric.active).flatMap<ClosingDefinition>(metric => {
    const dataset = metric.dataset ?? (group === 'ST' ? 'softbonus' : 'sellout');
    const field = dataset === 'softbonus' ? `softbonus.config.${metric.id}.achievement` : `${metric.id}.achievement`;
    if (fields.has(field)) return [];
    fields.add(field);
    return [{ id: `config:${dataset}:${metric.id}`, column: '', label: metric.label, section: 'Aktive Konfiguration',
      field, dataset, dataType: 'percent', required: true, active: true }];
  });
  return [...original, ...extra];
}

export function closingTemplate(group: Group): SheetPreview {
  const definitions = closingDefinitions(group);
  return { name: 'Pivot Liste', headerRow: 2, dimension: `A1:${definitions.at(-1)!.column}2`, rows: 2,
    columns: definitions.map(item => ({ key: item.column, label: item.label, section: item.section })) };
}

export function detectClosingGroup(filename: string, sheet: SheetPreview): Group | undefined {
  const prefix = filename.match(/^(HA|DA|HE|IM|LH|ST|SmartThings)\b/i)?.[1].toUpperCase();
  if (prefix) return prefix === 'HA' ? 'DA' : prefix === 'SMARTTHINGS' ? 'ST' : prefix as Group;
  if (!isPivotSheet(sheet.name)) return;
  const labels = sheet.columns.map(item => normalize(item.label));
  if (labels.includes('im sellout lt. targets')) return 'LH';
  if (labels.includes('laundry ttl')) return 'DA';
  if (labels.includes('im sales race')) return 'IM';
  if (labels.includes('marktzfriedenheit')) return 'ST';
  if (labels.includes('tv ttl tgt (30%)')) return 'HE';
}

export function closingMappings(sheet: SheetPreview, group: Group, metrics: AdminMetric[] = []): SourceColumnMapping[] {
  return closingDefinitions(group, metrics).map(definition => {
    const custom = definition.id.startsWith('config:');
    const exact = sheet.columns.filter(column => normalize(column.label) === normalize(definition.label));
    const source = custom ? undefined : exact.find(column => column.key === definition.column) ?? (exact.length === 1 ? exact[0] : undefined);
    return { id: definition.id, column: source?.key ?? '', sourceLabel: definition.label, sourceSection: source?.section || definition.section,
      dataset: definition.active ? definition.dataset : 'ignore', field: definition.field, dataType: definition.dataType, required: definition.required };
  });
}

export function mergeClosingMappings(sheet: SheetPreview, group: Group, metrics: AdminMetric[], previous: SourceColumnMapping[]): SourceColumnMapping[] {
  return closingMappings(sheet, group, metrics).map(next => {
    const existing = previous.find(item => item.id === next.id && item.field === next.field);
    return existing ? { ...next, column: existing.column, dataset: existing.dataset, dataType: existing.dataType } : next;
  });
}

export function mappingConflicts(mappings: SourceColumnMapping[]): Map<string, string[]> {
  const selected = new Map<string, string[]>();
  for (const item of mappings) {
    if (item.dataset === 'ignore' || !item.column) continue;
    selected.set(item.column, [...(selected.get(item.column) ?? []), item.sourceLabel]);
  }
  return new Map([...selected].filter(([, labels]) => labels.length > 1));
}

export function closingMappingError(sheet: SheetPreview, group: Group, mappings: SourceColumnMapping[], metrics: AdminMetric[] = []): string {
  const conflicts = mappingConflicts(mappings);
  if (conflicts.size) return `Spaltenkonflikt: ${[...conflicts].map(([column, labels]) => `${column} → ${labels.join(' / ')}`).join('; ')}.`;
  const missing = closingDefinitions(group, metrics).filter(def => def.required && !mappings.some(item => item.id === def.id && item.dataset !== 'ignore' && item.column && item.field === def.field));
  if (missing.length) return `Pflichtfelder fehlen: ${missing.map(item => item.label).join(', ')}.`;
  const unresolved = mappings.filter(item => item.dataset !== 'ignore' && (!item.column || !sheet.columns.some(column => column.key === item.column)));
  if (unresolved.length) return `Spalte wählen oder Feld deaktivieren: ${unresolved.map(item => item.sourceLabel).join(', ')}.`;
  const targets = mappings.filter(item => item.dataset !== 'ignore').map(item => item.field);
  if (new Set(targets).size !== targets.length) return 'Mehrere Felder verwenden dasselbe Importziel.';
  return '';
}

export type ImportedCell = ExcelCell & { sourceColumn: string };
export type ClosingRecord = { row: number; month: string; fields: Record<string, ImportedCell> };
export type ClosingResult = { records: ClosingRecord[]; issues: { row: number; column: string; message: string }[]; otherMonths: number; skipped: number; specialValues: number };
const blank: ExcelCell = { kind: 'blank', value: null };
export function excelMonth(value: ExcelCell['value'], date1904 = false): string | undefined {
  if (typeof value === 'number' && value >= (date1904 ? 1 : 61)) {
    const date = new Date((value - (date1904 ? 24107 : 25569)) * 86400000);
    return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 7) : undefined;
  }
  if (typeof value !== 'string') return;
  const iso = value.trim().match(/^(\d{4})-(0[1-9]|1[0-2])(?:-\d{2}(?:T.*)?)?$/);
  if (iso) return `${iso[1]}-${iso[2]}`;
  const german = value.trim().match(/^(?:\d{1,2}\.)?(0?[1-9]|1[0-2])[./](\d{4})$/);
  if (german) return `${german[2]}-${german[1].padStart(2, '0')}`;
}

function convertedCell(cell: ExcelCell, dataType: ColumnDataType): ExcelCell {
  if (cell.kind !== 'value') return cell;
  if (dataType === 'text') return { ...cell, value: String(cell.value ?? '') };
  if (typeof cell.value !== 'string' || !['number', 'currency', 'percent'].includes(dataType)) return cell;
  let text = cell.value.trim().replace(/\s|€|EUR/gi, '');
  if (/^(?:x|n\/?a|n\.a\.)$/i.test(text) || !text) return cell;
  const percent = text.endsWith('%');
  text = text.replace(/%$/, '');
  if (text.includes(',')) text = text.replace(/\./g, '').replace(',', '.');
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)) return cell;
  return { ...cell, value: Number(text) / (percent ? 100 : 1) };
}

/** Month-scoped local result. Keep records in memory, never localStorage or fixtures. */
export function prepareClosing(sheet: SheetPreview, group: Group, mappings: SourceColumnMapping[], month: string, metrics: AdminMetric[] = []): ClosingResult {
  const result: ClosingResult = { records: [], issues: [], otherMonths: 0, skipped: 0, specialValues: 0 };
  const mappingError = closingMappingError(sheet, group, mappings, metrics);
  if (mappingError) { result.issues.push({ row: 0, column: '', message: mappingError }); return result; }
  const active = mappings.filter(item => item.dataset !== 'ignore');
  const monthColumn = active.find(item => item.field === 'snapshot.reportMonth')!.column;
  const personColumn = active.find(item => item.field === 'person.externalId')!.column;
  const marketColumn = active.find(item => item.field === 'assignment.market')!.column;
  const keys = new Set<string>();
  for (const row of sheet.data ?? []) {
    if (!row.cells[personColumn]?.value && !row.cells[marketColumn]?.value && !row.cells.A?.value && !row.cells.C?.value && !excelMonth(row.cells[monthColumn]?.value ?? null, sheet.date1904)) { result.skipped++; continue; }
    // IM/LH contain a helper row A=1, B=2, …, M=13. It is not a person/month.
    if (Array.from({ length: 13 }, (_, index) => row.cells[String.fromCharCode(65 + index)]?.value === index + 1).every(Boolean)) { result.skipped++; continue; }
    const reportMonth = excelMonth(row.cells[monthColumn]?.value ?? null, sheet.date1904);
    if (!reportMonth) { result.issues.push({ row: row.row, column: monthColumn, message: 'Monat fehlt oder ist kein gültiges Excel-Datum.' }); continue; }
    if (reportMonth !== month) { result.otherMonths++; continue; }
    const fields: ClosingRecord['fields'] = {};
    for (const item of active) {
      const cell = row.cells[item.column] ?? blank;
      const converted = convertedCell(cell, item.dataType);
      fields[item.field] = { ...converted, sourceColumn: item.column };
      if (cell.kind === 'error' || cell.kind === 'uncached-formula') result.issues.push({ row: row.row, column: item.column, message: `${item.sourceLabel}: ${cell.kind === 'error' ? 'Excel-Fehler ' + cell.value : 'Formel ohne gespeicherten Wert'}.` });
      else if (item.required && (cell.kind === 'blank' || cell.value === '' || /^[x]$/i.test(String(cell.value)))) result.issues.push({ row: row.row, column: item.column, message: `${item.sourceLabel}: Pflichtwert fehlt.` });
      else if (typeof converted.value === 'string' && /^[x]$|^n\/?a$|^n\.a\.$/i.test(converted.value.trim())) result.specialValues++;
      else if (cell.kind === 'value' && typeof converted.value !== 'number' && ['number', 'currency', 'percent'].includes(item.dataType) && converted.value !== '') result.issues.push({ row: row.row, column: item.column, message: `${item.sourceLabel}: Zahl nicht lesbar.` });
    }
    const key = JSON.stringify([fields['assignment.sourceShopId']?.value ?? fields['person.externalId']?.value, fields['assignment.market']?.value, reportMonth]);
    if (keys.has(key)) result.issues.push({ row: row.row, column: personColumn, message: 'Doppelter SEC-/Markt-Datensatz für diesen Monat.' });
    keys.add(key);
    result.records.push({ row: row.row, month: reportMonth, fields });
  }
  return result;
}
