import { validateClosing, validateWeekly, type ImportContext } from './imports.ts';
import { type IdentityMatch, type ImportPerson, type ImportAssignment } from './identity.ts';
import { resolveRecipients, type PersonChoices, type StaffingHint } from './recipients.ts';
import { excelMonth } from '../shared/closingImport.ts';
import type { ExcelCell, SourceColumnMapping } from '../shared/admin.ts';
import type { ServerSheet } from './workbook.ts';
import { rosterForMonth, matchRosterMarket, type RosterEntry } from './roster.ts';
import {matchingStaffing,type StaffingEvidence} from './staffing.ts';

export type SkippedImportRow = IdentityMatch & { status:'skipped'; method:'vacant'|'manual-skip' };
const vacancy = new Set(['-', '–', '—', 'x', 'n/a', 'n.a.', 'na', 'no sec', 'kein sec', 'ohne sec', 'unbesetzt', 'nicht besetzt', 'vakant', 'vacant', 'offen', 'open', 'tbd']);
const isVacant = (value:string) => vacancy.has(value.trim().toLocaleLowerCase('de-AT').replace(/\s+/g,' '));
const sourceText = (cell:ExcelCell|undefined):string|null => !cell || cell.kind==='blank' ? '' : cell.kind==='value' ? String(cell.value??'').trim() : null;

/** Only explicit vacancy/blank employee cells are automatic exclusions. Unknown people stay errors. */
export function skippedImportRows(sheet:ServerSheet,mappings:SourceColumnMapping[],ctx:ImportContext,people:ImportPerson[],choices:PersonChoices={},reference:RosterEntry[]=[],previous:StaffingEvidence[]=[]):SkippedImportRow[]{
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
   const staffingSignal=matchingStaffing(sourceMarket,previous,ctx.asOf).length>0||sheet.columns.some(c=>/^(hours|stunden)$/i.test(c.label.trim())&&/\d\s*\+\s*\d/.test(String(row.cells[c.key]?.value??'')))||Object.values(row.cells).some(c=>typeof c.value==='string'&&/\blighthouse\b/i.test(c.value));
   const roster=matchRosterMarket(sourceMarket,[...rosterForMonth(reference,ctx.group,ctx.month),...(['HE','IM'].includes(ctx.group)&&ctx.phase!=='MONTH_FINALIZATION'?rosterForMonth(reference,'LH',ctx.month):[])]);
   // A blank legacy SEC column is not a vacancy when the maintained roster proves staffing.
   // An explicit "No SEC" retains its existing meaning until consciously corrected.
   if(isVacant(sourceName)||((id||name)&&emptyId&&emptyName&&!staffingSignal&&!roster.entries.length&&!roster.ambiguous))method='vacant';
  }
  if(method)skipped.push({row:row.row,sourceName,sourceExternalId,sourceMarket,personId:null,status:'skipped',method,score:null,message:method==='vacant'?'Unbesetzter Markt laut Excel. Diese Zeile wird nicht importiert.':'Bewusst übersprungen. Diese Zeile wird nicht importiert.'});
 }
 return skipped;
}

/** The same path handles weekly uploads and historical closing files, before cell validation. */
export function prepareImport(sheet:ServerSheet,mappings:SourceColumnMapping[],ctx:ImportContext,people:ImportPerson[],assignments:ImportAssignment[],choices:PersonChoices={},reference:RosterEntry[]=[],previous:StaffingEvidence[]=[],permitted:readonly string[]=['HE','IM']){
 const skippedRows=skippedImportRows(sheet,mappings,ctx,people,choices,reference,previous);
 const excluded=new Set(skippedRows.map(r=>r.row));
 const filtered={...sheet,data:sheet.data?.filter(r=>!excluded.has(r.row))};
 const pivot=sheet.name.replace(/[\s_-]/g,'').toLowerCase()==='pivotliste';
 const cellMappings=rosterForMonth(reference,ctx.group,ctx.month).length?mappings.map(m=>m.field==='person.externalId'?{...m,required:false}:m):mappings;
 const result=pivot?validateClosing(filtered,cellMappings,ctx):validateWeekly(filtered,cellMappings,ctx);
 const hours=sheet.columns.filter(c=>/^(hours|stunden)$/i.test(c.label.trim()));
 const hints=new Map<number,StaffingHint>((filtered.data??[]).map(r=>{
  const raw=hours.map(c=>String(r.cells[c.key]?.value??'')).find(s=>/\d\s*\+\s*\d/.test(s));
  const parts=raw?.trim().split(/\s*\+\s*/);
  return[r.row,{count:parts?.every(s=>/^\d+(?:[.,]\d+)?$/.test(s))?parts.length:null,lighthouse:Object.values(r.cells).some(c=>typeof c.value==='string'&&/\blighthouse\b/i.test(c.value))}];
 }));
 const identities=resolveRecipients(result.records,people,assignments,ctx,choices,reference,hints,previous,permitted);
 return {...result,sourceRecords:result.records,records:identities.records,issues:[...result.issues,...identities.issues],
  identityMatches:[...identities.matches,...skippedRows].sort((a,b)=>a.row-b.row),unresolvedCount:identities.unresolvedCount,
  skipped:result.skipped+skippedRows.length,skippedUnstaffed:skippedRows.filter(r=>r.method==='vacant').length,skippedManual:skippedRows.filter(r=>r.method==='manual-skip').length,
  skippedRows,
 };
}

/** A different exclusion selection must never reuse an earlier draft's row set. */
export const exclusionFingerprint = (rows:SkippedImportRow[]) => rows.map(r=>[r.row,r.method]).sort((a,b)=>Number(a[0])-Number(b[0]));
