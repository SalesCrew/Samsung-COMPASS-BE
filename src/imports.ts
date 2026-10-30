import {groupProjectAssessment} from '../shared/projectAssessment.ts';
import { groupMetricBlocks, type DASetting, type MetricDefinition, type SECGroup } from '../shared/groups.ts';
import { closingDefinitions, closingMappingError, prepareClosing, type ClosingRecord, type ImportedCell } from '../shared/closingImport.ts';
import type { AdminMetric, ExcelCell, ImportPhase, SourceColumnMapping } from '../shared/admin.ts';
import type { ServerSheet } from './workbook.ts';

export type Group = SECGroup['id'];
export type NormalizedRow = { row:number;externalId:string;name:string;market:string;sourceShopId:string|null;fields:Record<string,ImportedCell>;normalized:Record<string,unknown> };
export type ImportContext = { group:Group;setting:DASetting;month:string;phase:ImportPhase;asOf:string;configurationVersion:string;metrics?:AdminMetric[] };
export type ImportIssue = {row:number;column:string;message:string};
const deniedFields=new Set(['premium.salary','assignment.comment','attendance.reason','attendance.code']);
export const privacyMappings=(mappings:SourceColumnMapping[])=>mappings.map(m=>deniedFields.has(m.field)?{...m,dataset:'ignore' as const}:m);
export function sourcePeriod(sheet:ServerSheet){
  const rows=sheet.allRows.filter(r=>r.row<(sheet.headerRow??1));
  const edi=rows.find(r=>Object.values(r.cells).some(c=>/EDI\s*Data\s*period/i.test(String(c.value??''))));
  const header=(edi?[edi]:rows).flatMap(r=>Object.values(r.cells).map(c=>String(c.value??''))).join(' ');
  const match=header.match(/(\d{2})\.(\d{2})\.(\d{4})\s*[-–]\s*(\d{2})\.(\d{2})\.(\d{4})/);
  return match?{from:match[3]+'-'+match[2]+'-'+match[1],asOf:match[6]+'-'+match[5]+'-'+match[4],month:match[6]+'-'+match[5]}:null;
}
const text=(cell:ExcelCell|undefined)=>cell?.kind==='value'?String(cell.value??'').trim():'';
const numeric=(cell:ExcelCell|undefined)=>cell?.kind==='value'&&typeof cell.value==='number'&&Number.isFinite(cell.value)?cell.value:null;
const percent=(cell:ExcelCell|undefined)=>{const n=numeric(cell);return n===null?null:Math.round(n*100000)/1000;};
const state=(cell:ExcelCell|undefined)=>!cell||cell.kind==='blank'?'missing':cell.kind!=='value'?'invalid':typeof cell.value==='string'&&/^(?:x|n\/?a|n\.a\.)$/i.test(cell.value.trim())?'not-applicable':numeric(cell)===null?'invalid':'value';

function definitions(ctx:ImportContext):MetricDefinition[]{
  if(!ctx.metrics?.length)return groupMetricBlocks(ctx.group,ctx.setting).flatMap(b=>b.metrics.map(m=>({...m,block:b.label})));
  return ctx.metrics.filter(m=>m.active&&(m.dataset!=='softbonus'||ctx.group==='ST')).map(m=>({key:m.id,label:m.label,unit:m.unit,weight:m.weight,icon:'check',block:m.block}));
}
function baseRow(record:ClosingRecord,normalized:Record<string,unknown>):NormalizedRow{
  const fields=Object.fromEntries(Object.entries(record.fields).filter(([k])=>!deniedFields.has(k)));
  return{row:record.row,externalId:text(fields['person.externalId']),name:text(fields['person.name']),market:text(fields['assignment.market']),sourceShopId:text(fields['assignment.sourceShopId'])||null,fields,normalized};
}
export function normalizeClosing(record:ClosingRecord,ctx:ImportContext):NormalizedRow{
  const f=record.fields;
  const metrics=definitions(ctx).map(m=>{
    const cell=f[m.key+'.achievement']??f['softbonus.config.'+m.key+'.achievement'];
    return{...m,resultState:state(cell),achievement:percent(cell),actual:null,target:null};
  });
  // Preserve supplied qualitative columns individually; do not invent a combined score or missing weights.
  const source=closingDefinitions(ctx.group,ctx.metrics??[]);
  const qualitative=groupProjectAssessment(source.filter(d=>d.dataset==='softbonus'&&d.field!=='softbonus.overall'&&f[d.field]).map(d=>{
    const configured=ctx.metrics?.find(m=>d.field==='softbonus.config.'+m.id+'.achievement');
    return{key:configured?.id??d.field,label:configured?.label??d.label.replace(/\s+/g,' '),unit:'%',weight:configured?.weight??null,icon:'check',resultState:state(f[d.field]),achievement:percent(f[d.field]),actual:null,target:null};
  }));
  const categoryCell=f['annual.monthPoints'];
  const suppliedPoints=numeric(categoryCell);
  const category=text(f['annual.monthCategory'])||text(categoryCell);
  const tier=/gold/i.test(category)||suppliedPoints===3?'gold':/silber|silver/i.test(category)||suppliedPoints===2?'silver':/bronze/i.test(category)||suppliedPoints===1?'bronze':'unavailable';
  const extraFields=source.filter(d=>['premium.onTop','premium.salesRace'].includes(d.field));
  const extrasAvailable=extraFields.every(d=>['value','not-applicable'].includes(state(f[d.field])));
  const extras=[['premium.onTop','On-top'],['premium.salesRace','Sales Race']].flatMap(([key,type])=>{const amount=numeric(f[key]);return amount===null?[]:[{type,amount}];});
  const normalized={groupId:ctx.group,month:ctx.month,setting:ctx.setting,configurationVersion:ctx.configurationVersion,
    sellout:ctx.group==='ST'?null:percent(f['sellout.overall']),softbonus:percent(f['softbonus.overall']),tier,
    points:ctx.group==='ST'?null:suppliedPoints,sourceLevel:text(f['annual.sourceLevel'])||null,
    premium:numeric(f['premium.achieved']),extras,extrasAvailable,metrics:ctx.group==='ST'?qualitative:metrics,qualitative,
    changed:['Monatsabschluss'],source:'Pivot Liste',sourceRow:record.row,
  };
  return baseRow(record,normalized);
}
export function validateClosing(sheet:ServerSheet,mappings:SourceColumnMapping[],ctx:ImportContext){
  if(ctx.phase!=='MONTH_FINALIZATION')throw new Error('Pivot Liste ist ein Monatsabschluss. Für Wochenstände bitte die Target-/Progress-Liste wählen.');
  const safe=privacyMappings(mappings);
  const result=prepareClosing(sheet,ctx.group,safe,ctx.month,ctx.metrics??[]);
  return{...result,records:result.records.map(r=>normalizeClosing(r,ctx))};
}

/** Verified original HE weekly layout; unknown layouts require explicit column mapping. */
export function weeklyMappings(sheet:ServerSheet,ctx:ImportContext):SourceColumnMapping[]{
  const mappings:SourceColumnMapping[]=[];
  const add=(column:string,label:string,field:string,dataType:SourceColumnMapping['dataType'],required=false)=>mappings.push({id:field,column,sourceLabel:label,dataset:field.startsWith('person.')?'identity':field.startsWith('assignment.')?'assignment':'sellout',field,dataType,required});
  const find=(labels:string[])=>sheet.columns.find(c=>labels.some(l=>c.label.trim().toLowerCase()===l))?.key??'';
  add(find(['sec id','promoter id']),'SEC ID','person.externalId','text',true);
  add(find(['store','markt','market']),'Markt','assignment.market','text',true);
  add(find(['name','sec name','promoter name']),'Name','person.name','text');
  const he=ctx.group==='HE'&&sheet.columns.find(c=>c.key==='F')?.label==='TGT'&&sheet.columns.find(c=>c.key==='D')?.label==='SEC ID';
  const tracker=['DA','IM'].includes(ctx.group)&&sheet.columns.find(c=>c.key==='C')?.label==='Store'&&sheet.columns.find(c=>c.key==='D')?.label==='SEC';
  if(he)mappings.find(m=>m.field==='person.name')!.column='C';
  const trackerKeys:Record<string,[string,string]>={laundry:['F','L'],ref:['N','T'],'vc-stick':['V','AC'],'vc-premium':['AE','AK'],flagship:['F','L'],'a-series':['N','T'],'hhp-asp':['V','AB'],wear:['AD','AJ'],tablet:['AL','AR'],accessories:['AW','BC']};
  const keys:Record<string,[string,string]>={units:['F','G'],soundbar:['I','J'],asp:['L','M'],share:['O','P']};
  for(const m of definitions(ctx)){
    const pair=he?keys[m.key]:tracker?trackerKeys[m.key]:undefined;
    const target=pair?.[0]??sheet.columns.find(c=>c.label.toLowerCase()===m.label.toLowerCase()+' target')?.key??'';
    const actual=pair?.[1]??sheet.columns.find(c=>c.label.toLowerCase()===m.label.toLowerCase()+' actual')?.key??'';
    add(target,m.label+' · Ziel',m.key+'.target',m.unit==='%'?'percent':m.unit==='€'?'currency':'number',true);
    add(actual,m.label+' · Ist',m.key+'.actual',m.unit==='%'?'percent':m.unit==='€'?'currency':'number',ctx.phase!=='TARGET_INITIALIZATION');
  }
  if(he)add('R','Total T/A%','sellout.overall','percent');
  if(tracker)add(ctx.group==='IM'?'BE':ctx.setting==='laundry-ref'?'AO':ctx.setting==='vc'?'AQ':'AM','Total T/A%','sellout.overall','percent');
  return mappings;
}
function convert(cell:ExcelCell,type:SourceColumnMapping['dataType']):ExcelCell{
  if(cell.kind!=='value'||typeof cell.value!=='string'||type==='text')return type==='text'&&cell.kind==='value'?{...cell,value:String(cell.value??'')}:cell;
  let s=cell.value.trim().replace(/\s|€|EUR/gi,'');const p=s.endsWith('%');s=s.replace(/%$/,'');
  if(s.includes(','))s=s.replace(/\./g,'').replace(',','.');
  return /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(s)?{...cell,value:Number(s)/(p?100:1)}:cell;
}
export function validateWeekly(sheet:ServerSheet,mappings:SourceColumnMapping[],ctx:ImportContext){
  const safe=privacyMappings(mappings).filter(m=>m.dataset!=='ignore'&&m.column);
  const issues:ImportIssue[]=[];const records:NormalizedRow[]=[];let skipped=0;let specialValues=0;
  const keys=new Set<string>();const sources=new Set<string>();
  for(const m of safe){if(sources.has(m.column))issues.push({row:0,column:m.column,message:'Quellspalte ist mehrfach zugeordnet.'});sources.add(m.column);if(!sheet.columns.some(c=>c.key===m.column))issues.push({row:0,column:m.column,message:'Quellspalte fehlt.'});}
  if(!safe.some(m=>['person.externalId','person.name','assignment.market'].includes(m.field)))issues.push({row:0,column:'',message:'Name, SEC-ID oder Markt muss zugeordnet sein.'});
  for(const f of definitions(ctx).map(m=>m.key+'.target')){
    if(!safe.some(m=>m.field===f))issues.push({row:0,column:'',message:'Pflichtzuordnung fehlt: '+f});
  }
  if(ctx.phase==='MONTH_FINALIZATION')issues.push({row:0,column:'',message:'Wochenliste darf keinen Monatsabschluss oder Prämien erzeugen.'});
  if(issues.length)return{records,issues,skipped,specialValues,otherMonths:0};
  const period=sourcePeriod(sheet);
  if(period&&(!period.from.startsWith(ctx.month)||period.month!==ctx.month))issues.push({row:0,column:'',message:'Der gewählte Monat passt nicht zum EDI-Zeitraum der Datei.'});
  if(period&&period.asOf!==ctx.asOf)issues.push({row:0,column:'',message:'Der Datenstand muss dem Ende des EDI-Zeitraums entsprechen.'});
  for(const r of sheet.data??[]){
    const fields:Record<string,ImportedCell>={};
    for(const m of safe)fields[m.field]={...convert(r.cells[m.column]??{kind:'blank',value:null},m.dataType),sourceColumn:m.column};
    const id=text(fields['person.externalId']);const market=text(fields['assignment.market']);
    const name=text(fields['person.name']);
    if(!id&&!name&&!market){skipped++;continue;}
    if(!id&&/^(?:total|gesamt|summe)$/i.test(market)){skipped++;continue;}
    const key=(id||name)+'|'+market;
    if(keys.has(key)){issues.push({row:r.row,column:'',message:'Doppelter SEC-/Markt-Datensatz.'});continue;}keys.add(key);
    const metrics=definitions(ctx).map(m=>{
      const tm=safe.find(v=>v.field===m.key+'.target');const am=safe.find(v=>v.field===m.key+'.actual');
      const tc=fields[m.key+'.target'];const ac=fields[m.key+'.actual'];
      for(const c of [tc,ac])if(c?.kind==='error'||c?.kind==='uncached-formula')issues.push({row:r.row,column:c.sourceColumn,message:'Excel-Fehler oder Formel ohne gespeicherten Wert.'});
      const target=tm?.dataType==='percent'?percent(tc):numeric(tc);
      const sourceActual=am?.dataType==='percent'?percent(ac):numeric(ac);
      if(target===null||target<0)issues.push({row:r.row,column:tm?.column??'',message:m.label+': Monatsziel fehlt oder ist ungültig.'});
      if(sourceActual!==null&&sourceActual<0)issues.push({row:r.row,column:am?.column??'',message:m.label+': Istwert ist ungültig.'});
      if(ctx.phase==='TARGET_INITIALIZATION'&&sourceActual!==null&&sourceActual!==0)issues.push({row:r.row,column:am?.column??'',message:'Targetbasis enthält bereits Istwerte. Als Wochenstand importieren.'});
      if(ac?.kind==='value'&&typeof ac.value==='string'&&/^(?:x|n\/?a|n\.a\.)$/i.test(ac.value.trim()))specialValues++;
      else if(ac?.kind==='value'&&sourceActual===null&&ac.value!=='')issues.push({row:r.row,column:am?.column??'',message:m.label+': Istwert nicht lesbar.'});
      return{...m,target,actual:ctx.phase==='TARGET_INITIALIZATION'?null:sourceActual};
    });
    records.push(baseRow({row:r.row,month:ctx.month,fields},{groupId:ctx.group,month:ctx.month,setting:ctx.setting,metrics,phase:ctx.phase,configurationVersion:ctx.configurationVersion,sellout:percent(fields['sellout.overall'])}));
  }
  return{records,issues,skipped,specialValues,otherMonths:0};
}
export function validateContext(ctx:ImportContext){
  if(!['HE','DA','IM','LH','ST'].includes(ctx.group)||!['full','laundry-ref','vc'].includes(ctx.setting))throw new Error('Ungültige Zuordnung.');
  if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(ctx.month)||!/^\d{4}-\d{2}-\d{2}$/.test(ctx.asOf)||!ctx.asOf.startsWith(ctx.month))throw new Error('Ungültiger Berichtsmonat oder Datenstand.');
  const date=new Date(ctx.asOf+'T12:00:00Z');if(!Number.isFinite(date.valueOf())||date.toISOString().slice(0,10)!==ctx.asOf)throw new Error('Ungültiger Datenstichtag.');
}

