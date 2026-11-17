import test from 'node:test';import assert from 'node:assert/strict';
import {prepareImport} from '../src/importPreparation.ts';
import {closingTemplate,closingMappings} from '../shared/closingImport.ts';
const v=value=>({kind:'value',value});
const people=['a','b','c'].map(id=>({id,external_id:'SEC-'+id,name:'Synthetic '+id}));
const assignment=(id,department='HE',market='Media Markt Musterstadt Hauptstraße 1a')=>({person_id:id,department_id:department,setting:'full',market});
const roster=(id,department='HE',market=assignment(id).market)=>({id:'ref-'+id,person_id:id,department_id:department,market,source_month:'2026-10',source_hash:'a'.repeat(64),imported_at:'2026-11-17T10:00:00Z'});
const ctx={group:'HE',setting:'full',month:'2026-10',asOf:'2026-10-29',phase:'WEEKLY_PROGRESS',configurationVersion:'test',metrics:[{id:'units',label:'TV Units',active:true,unit:'Stück',block:'HE',dataset:'sellout',weight:100}]};
const maps=[['A','person.externalId','identity','text'],['B','person.name','identity','text'],['C','assignment.market','assignment','text'],['D','units.target','sellout','number'],['E','units.actual','sellout','number']].map(([column,field,dataset,dataType])=>({column,field,dataset,dataType,sourceLabel:field,required:true}));
const row={row:2,cells:{A:v(''),B:v(''),C:v('MM Musterstadt Hauptstrasse 1A'),D:v(10),E:v(-2),F:v('35+35'),G:v('Full')}};
const sheet={name:'Weekly',columns:[...maps.map(m=>({key:m.column,label:m.sourceLabel})),{key:'F',label:'HOURS'},{key:'G',label:'Type'}],allRows:[],data:[row]};
const prepare=(s=sheet,c=ctx,a=[assignment('a'),assignment('b')],r=[roster('a'),roster('b')],choices={})=>prepareImport(s,maps,c,people,a,choices,r);
test('35+35 yields two canonical recipients with unchanged shared signed MTD values and source row',()=>{
 const result=prepare();assert.deepEqual(result.issues,[]);assert.equal(result.records.length,2);assert.equal(result.identityMatches.length,1);assert.equal(result.identityMatches[0].recipients.length,2);
 for(const record of result.records){assert.equal(record.normalized.metrics[0].target,10);assert.equal(record.normalized.metrics[0].actual,-2);assert.equal(record.row,2);assert.equal(record.market,assignment('a').market);assert.equal(record.fields['person.name'],undefined);}
 assert.deepEqual(new Set(result.records.map(r=>r.externalId)),new Set(['SEC-a','SEC-b']));
});
test('roster-confirmed double staffing also works without HOURS and manual choices must include both',()=>{
 assert.equal(prepare({...sheet,data:[{...row,cells:{...row.cells,F:v('')}}]}).records.length,2);
 assert.equal(prepare(sheet,ctx,undefined,undefined,{'2':['a']}).unresolvedCount,1);
 assert.equal(prepare(sheet,ctx,undefined,undefined,{'2':['a','a']}).unresolvedCount,1);
 assert.equal(prepare(sheet,ctx,undefined,undefined,{'2':['a','b']}).records.length,2);
 assert.equal(prepare(sheet,ctx,undefined,undefined,{'2':'skip'}).records.length,0);
});
test('wrong division, address branch, unlinked staff and contradicting identities block the whole source row',()=>{
 assert.equal(prepare(sheet,ctx,[assignment('a'),assignment('b','IM')]).unresolvedCount,1);
 assert.equal(prepare(sheet,ctx,[assignment('a'),assignment('b','HE','Media Markt Musterstadt Hauptstraße 2')]).unresolvedCount,1);
 assert.equal(prepare(sheet,ctx,undefined,[roster('a'),{...roster('b'),person_id:null}]).unresolvedCount,1);
 assert.equal(prepare({...sheet,data:[{...row,cells:{...row.cells,A:v('SEC-c')}}]}).unresolvedCount,1);
 const duplicate=prepare({...sheet,data:[row,{...row,row:3}]});assert.ok(duplicate.issues.some(i=>/Doppel/.test(i.message)));
});
test('LH recipients receive source-prefixed metrics in their own LH assignments; no personal payouts or source identities',()=>{
 const lighthouse={...sheet,data:[{...row,cells:{...row.cells,G:v('TV Lighthouse')}}]};
 const result=prepare(lighthouse,ctx,[assignment('a','LH'),assignment('b','LH')],[roster('a','LH'),roster('b','LH')]);
 assert.deepEqual(result.issues,[]);assert.equal(result.records.length,2);assert.equal(result.skippedUnstaffed,0);
 for(const r of result.records){assert.equal(r.normalized.groupId,'LH');assert.equal(r.normalized.sourceGroup,'HE');assert.equal(r.normalized.metrics[0].key,'he-units');assert.equal(r.normalized.premium,undefined);assert.equal(r.normalized.softbonus,undefined);assert.equal(r.normalized.identity.sourceName,undefined);}
 const im=prepare(lighthouse,{...ctx,group:'IM',metrics:[{...ctx.metrics[0],id:'units'}]},[assignment('a','LH'),assignment('b','LH')],[roster('a','LH'),roster('b','LH')]);
 assert.deepEqual(im.issues,[]);assert.equal(im.records[0].normalized.metrics[0].key,'im-units');
});
test('a Lighthouse market may contain one regular SEC and one LH SEC without changing their roles',()=>{
 const result=prepare({...sheet,data:[{...row,cells:{...row.cells,G:v('TV Lighthouse')}}]},ctx,[assignment('a'),assignment('b','LH')],[roster('a'),roster('b','LH')]);
 assert.deepEqual(result.issues,[]);assert.deepEqual(result.records.map(r=>r.normalized.groupId),['LH','HE']);
});
test('historical dates cannot reuse a later roster; missing second employee remains reviewable',()=>{
 const result=prepare(sheet,{...ctx,month:'2026-09',asOf:'2026-09-29'});assert.equal(result.unresolvedCount,1);assert.equal(result.records.length,0);
 assert.equal(prepare(sheet,ctx,[assignment('a')],[roster('a')]).unresolvedCount,1);
});
test('two personal monthly closings at one shop preserve each individual premium and qualitative value',()=>{
 const template=closingTemplate('HE'),mappings=closingMappings(template,'HE');
 const make=(n,id,amount,score)=>{const cells=Object.fromEntries(mappings.filter(m=>m.dataset!=='ignore'&&m.column).map(m=>[m.column,v(m.dataType==='text'?'source':m.dataType==='date'?'2026-10-01':1)]));
 for(const[field,value]of [['person.externalId','SEC-'+id],['person.name','Synthetic '+id],['assignment.sourceShopId','same-shop'],['assignment.market',assignment(id).market],['snapshot.reportMonth','2026-10-01'],['premium.achieved',amount],['softbonus.overall',score],['assignment.hoursRaw','35+35']]){const m=mappings.find(m=>m.field===field);if(m)cells[m.column]=v(value);}return{row:n,cells};};
 const input={...template,allRows:[],data:[make(3,'a',111,.93),make(4,'b',222,.97)]};
 const result=prepareImport(input,mappings,{...ctx,phase:'MONTH_FINALIZATION'},people,[assignment('a'),assignment('b')],{},[roster('a'),roster('b')]);
 assert.deepEqual(result.issues,[]);assert.deepEqual(result.records.map(r=>r.normalized.premium),[111,222]);assert.deepEqual(result.records.map(r=>r.normalized.softbonus),[93,97]);
 const invalid=prepareImport(input,mappings,{...ctx,phase:'MONTH_FINALIZATION'},people,[assignment('a'),assignment('b')],{'3':['a','b']},[roster('a'),roster('b')]);assert.ok(invalid.issues.some(i=>/persönliche/.test(i.message)));
});
