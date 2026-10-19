import { Unzip, UnzipInflate } from 'fflate';
import { DOMParser } from '@xmldom/xmldom';
import type { ExcelCell, SheetPreview } from '../shared/admin.ts';

type XML = ReturnType<DOMParser['parseFromString']>;
type Element = ReturnType<XML['getElementsByTagName']>[number];
const children = (parent: XML | Element, name: string) => Array.from(parent.getElementsByTagName('*')).filter(el => el.localName === name);
const columnIndex = (name: string) => [...name].reduce((n,c)=>n*26+c.charCodeAt(0)-64,0);
const columnName = (n: number) => { let name=''; for(let v=n;v>0;v=Math.floor((v-1)/26)) name=String.fromCharCode(65+(v-1)%26)+name; return name; };
const normalize = (s:string)=>s.toLowerCase().replace(/[^a-z0-9äöü]/g,'');
export type ServerSheet = SheetPreview & { allRows: {row:number;cells:Record<string,ExcelCell>}[] };

/** Bounded streaming unzip; selected XML only, no VBA, external links or formula evaluation. */
export function readWorkbook(bytes: Uint8Array, filename: string): ServerSheet[] {
  if (!/\.(xlsx|xlsm)$/i.test(filename) || bytes.length>30*1024*1024 || bytes.length<4) throw new Error('Bitte eine Excel-Datei bis 30 MB wählen.');
  const archive: Record<string,Uint8Array>={}; let total=0; let failure: Error | null=null; let fileCount=0;
  const zip=new Unzip(file=>{
    if (++fileCount>3000) throw new Error('Zu viele Excel-Dateiteile.');
    if (!/^xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|worksheets\/[^/]+\.xml)$/.test(file.name)) return;
    if (archive[file.name]) throw new Error('Doppelte Excel-Dateiteile.');
    let length=0; const chunks:Uint8Array[]=[];
    file.ondata=(error,chunk,final)=>{
      if(error){failure=new Error('Excel-Archiv ist beschädigt.');file.terminate();return;}
      length+=chunk.length;total+=chunk.length;
      if(length>32*1024*1024 || total>128*1024*1024){failure=new Error('Excel-Datei ist nach Entpacken zu groß.');file.terminate();return;}
      chunks.push(chunk);
      if(final){const out=new Uint8Array(length);let offset=0;for(const c of chunks){out.set(c,offset);offset+=c.length;}archive[file.name]=out;}
    };
    file.start();
  });
  zip.register(UnzipInflate);
  for(let offset=0;offset<bytes.length;offset+=2048){
    zip.push(bytes.subarray(offset,offset+2048),offset+2048>=bytes.length);
    if(failure) throw failure;
  }
  const read=(path:string)=>{
    if(!archive[path]) throw new Error('Ein Excel-Dateiteil fehlt.');
    const source=new TextDecoder().decode(archive[path]);
    if (/<!DOCTYPE|<!ENTITY/i.test(source)) throw new Error('XML-Dokumenttypen und Entitäten sind nicht erlaubt.');
    return new DOMParser({onError:(level)=>{if(level==='error'||level==='fatalError')throw new Error('Ungültige Excel-XML-Struktur.');}}).parseFromString(source,'application/xml');
  };
  const book=read('xl/workbook.xml');
  const date1904=['1','true'].includes(children(book,'workbookPr')[0]?.getAttribute('date1904') ?? '');
  const relationships=new Map(children(read('xl/_rels/workbook.xml.rels'),'Relationship').filter(r=>r.getAttribute('TargetMode')!=='External').map(r=>[r.getAttribute('Id'),r.getAttribute('Target')??'']));
  const strings=archive['xl/sharedStrings.xml']?children(read('xl/sharedStrings.xml'),'si').map(si=>children(si,'t').map(t=>t.textContent??'').join('')):[];
  const value=(cell:Element):ExcelCell=>{
    const raw=children(cell,'v')[0]?.textContent;const type=cell.getAttribute('t');
    if(type==='e')return{kind:'error',value:raw??'#ERROR!'};
    if(children(cell,'f').length&&raw==null)return{kind:'uncached-formula',value:null};
    if(type==='inlineStr')return{kind:'value',value:children(cell,'t').map(t=>t.textContent??'').join('')};
    if(raw==null||raw==='')return{kind:'blank',value:null};
    if(type==='s')return{kind:'value',value:strings[Number(raw)]??''};
    if(type==='b')return{kind:'value',value:raw==='1'};
    if(type==='str'||type==='d')return{kind:'value',value:raw};
    const n=Number(raw);return{kind:'value',value:Number.isFinite(n)?n:raw};
  };
  return children(book,'sheet').map((sheet,index)=>{
    const name=sheet.getAttribute('name')??'Sheet '+(index+1);
    const target=relationships.get(sheet.getAttribute('r:id'))??'worksheets/sheet'+(index+1)+'.xml';
    const path=new URL(target,'https://workbook.local/xl/').pathname.slice(1);
    const doc=read(path);
    const allRows=children(doc,'row').map(row=>({row:Number(row.getAttribute('r')),cells:Object.fromEntries(children(row,'c').map(cell=>[cell.getAttribute('r')?.match(/^[A-Z]+/)?.[0]??'',value(cell)]))}));
    if(allRows.length>50000)throw new Error('Zu viele Zeilen im Arbeitsblatt.');
    const pivot=normalize(name)==='pivotliste';
    const candidate=allRows.slice(0,25).find(row=>Object.values(row.cells).some(c=>['secid','promoterid'].includes(normalize(String(c.value??'')))));
    const trackerHeader=allRows.slice(0,25).find(row=>String(row.cells.C?.value??'').trim()==='Store'&&String(row.cells.D?.value??'').trim()==='SEC'&&String(row.cells.F?.value??'').trim()==='TGT');
    const headerRow=pivot?2:candidate?.row??trackerHeader?.row??1;
    const header=allRows.find(r=>r.row===headerRow)?.cells??{};
    const sectionRows=allRows.filter(r=>r.row<headerRow);
    const maxColumn=Math.max(1,...Object.keys(header).filter(k=>header[k].value!=null&&header[k].value!=='').map(columnIndex));
    if(maxColumn>512)throw new Error('Zu viele Spalten im Arbeitsblatt.');
    let section='';
    const columns=Array.from({length:maxColumn},(_,i)=>{
      const key=columnName(i+1);
      const labels=sectionRows.map(r=>String(r.cells[key]?.value??'').trim()).filter(s=>s&&!/^[-+]?\d+(?:[.,]\d+)?%?$/.test(s));
      if(labels.length)section=labels.at(-1)!;
      return{key,label:String(header[key]?.value??'').trim(),section};
    });
    return{name,dimension:children(doc,'dimension')[0]?.getAttribute('ref')??'—',columns,rows:allRows.length,headerRow,date1904,data:allRows.filter(r=>r.row>headerRow),allRows};
  });
}

