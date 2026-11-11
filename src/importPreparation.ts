import { validateClosing, validateWeekly, type ImportContext } from './imports.ts';
import { resolveImportPeople, type IdentityMatch, type ImportPerson, type ImportAssignment } from './identity.ts';
import { excelMonth } from '../shared/closingImport.ts';
import type { ExcelCell, SourceColumnMapping } from '../shared/admin.ts';
import type { ServerSheet } from './workbook.ts';

export type SkippedImportRow = IdentityMatch & { status:'skipped'; method:'vacant'|'manual-skip' };
const vacancy = new Set(['-', '–', '—', 'x', 'n/a', 'n.a.', 'na', 'no sec', 'kein sec', 'ohne sec', 'unbesetzt', 'nicht besetzt', 'vakant', 'vacant', 'offen', 'open', 'tbd']);
const isVacant = (value:string) => vacancy.has(value.trim().toLocaleLowerCase('de-AT').replace(/\s+/g,' '));
const sourceText = (cell:ExcelCell|undefined):string|null => !cell || cell.kind==='blank' ? '' : cell.kind==='value' ? String(cell.value??'').trim() : null;

/** Only explicit vacancy/blank employee cells are automatic exclusions. Unknown people stay errors. */
export function skippedImportRows(sheet:ServerSheet,mappings:SourceColumnMapping[],ctx:ImportContext,people:ImportPerson[],choices:Record<string,string>={}):SkippedImportRow[]{
 const column=(field:string)=>mappings.find(m=>m.dataset!=='ignore'&&m.field===field&&sheet.columns.some(c=>c.key===m.column))?.column;
 const id=column('person.externalId'),name=column('person.name'),market=column('assignment.market'),month=column('snapshot.reportMonth');
 const knownIds=new Set(people.map(p=>p.external_id));
 const skipped:SkippedImportRow[]=[];
 for(const row of sheet.data??[]){
  const selected=choices[String(row.row)];
  const sourceExternalId=sourceText(id?row.cells[id]:undefined),sourceName=sourceText(name?row.cells[name]:undefined),sourceMarket=sourceText(market?row.cells[market]:undefined);
  if(selected==='skip'){skipped.push({row:row.row,sourceName:sourceName??'',sourceExternalId:sourceExternalId??'',sourceMarket:sourceMarket??'',personId:null,status:'skipped',method:'manual-skip',score:null,message:'Bewusst übersprungen. Diese Zeile wird nicht importiert.'});continue;}
  if(sourceExternalId===null||sourceName===null||sourceMarket===null)continue; // never hide unreadable identity cells
  if(!sourceExternalId&&!sourceName&&!sourceMarket)continue;
  if(!sourceExternalId&&!sourceName&&/^(?:total|gesamt|summe)$/i.test(sourceMarket))continue;
  if(month){const reportMonth=excelMonth(row.cells[month]?.value??null,sheet.date1904);if(reportMonth&&reportMonth!==ctx.month)continue;}
  let method:SkippedImportRow['method']|null=null;
  if(!selected&&sourceMarket&&!knownIds.has(sourceExternalId)){
   const emptyId=!sourceExternalId||sourceExternalId==='0'||isVacant(sourceExternalId);
   const emptyName=!sourceName||isVacant(sourceName);
   if(isVacant(sourceName)||((id||name)&&emptyId&&emptyName))method='vacant';
  }
  if(method)skipped.push({row:row.row,sourceName,sourceExternalId,sourceMarket,personId:null,status:'skipped',method,score:null,message:method==='vacant'?'Unbesetzter Markt laut Excel. Diese Zeile wird nicht importiert.':'Bewusst übersprungen. Diese Zeile wird nicht importiert.'});
 }
 return skipped;
}

/** The same path handles weekly uploads and historical closing files, before cell validation. */
export function prepareImport(sheet:ServerSheet,mappings:SourceColumnMapping[],ctx:ImportContext,people:ImportPerson[],assignments:ImportAssignment[],choices:Record<string,string>={}){
 const skippedRows=skippedImportRows(sheet,mappings,ctx,people,choices);
 const excluded=new Set(skippedRows.map(r=>r.row));
 const filtered={...sheet,data:sheet.data?.filter(r=>!excluded.has(r.row))};
 const pivot=sheet.name.replace(/[\s_-]/g,'').toLowerCase()==='pivotliste';
 const result=pivot?validateClosing(filtered,mappings,ctx):validateWeekly(filtered,mappings,ctx);
 const identities=resolveImportPeople(result.records,people,assignments,ctx.group,ctx.setting,choices);
 return {...result,sourceRecords:result.records,records:identities.records,issues:[...result.issues,...identities.issues],
  identityMatches:[...identities.matches,...skippedRows].sort((a,b)=>a.row-b.row),unresolvedCount:identities.unresolvedCount,
  skipped:result.skipped+skippedRows.length,skippedUnstaffed:skippedRows.filter(r=>r.method==='vacant').length,skippedManual:skippedRows.filter(r=>r.method==='manual-skip').length,
  skippedRows,
 };
}

/** A different exclusion selection must never reuse an earlier draft's row set. */
export const exclusionFingerprint = (rows:SkippedImportRow[]) => rows.map(r=>[r.row,r.method]).sort((a,b)=>Number(a[0])-Number(b[0]));
