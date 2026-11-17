import test from 'node:test';import assert from 'node:assert/strict';
import {parseRoster,marketKey,marketSimilarity,rosterForMonth,matchRosterMarket} from '../src/roster.ts';
import {resolveImportPeople} from '../src/identity.ts';
import {prepareImport} from '../src/importPreparation.ts';
import {closingTemplate,closingMappings} from '../shared/closingImport.ts';
const v=value=>({kind:'value',value});
const person={id:'a',external_id:'SEC-A',name:'Anna Beispiel'};
const assignment={person_id:'a',department_id:'HE',setting:'full',market:'Media Markt Musterstadt Hauptstraße 1a'};
const reference={id:'r',person_id:'a',department_id:'HE',market:assignment.market,source_month:'2026-10',source_hash:'a'.repeat(64),imported_at:'2026-11-17T10:00:00Z'};
const source=(market='MM Musterstadt Hauptstrasse 1A')=>({row:2,name:'',externalId:'',market,fields:{},normalized:{},sourceShopId:null});
test('case, chain abbreviation, reordered words and street abbreviations resolve; branch numbers stay significant',()=>{
 assert.equal(marketKey('MediaMarkt Musterstadt HAUPTSTRASSE 1 A'),marketKey('MM Musterstadt Hauptstraße 1a'));
 assert.equal(marketSimilarity('MM Musterstadt Hauptstraße 1a','Media Markt Hauptstrasse 1A Musterstadt'),1);
 assert.equal(marketSimilarity('MM Musterstadt Hauptstraße 1a','MM Musterstadt Hauptstraße 1b'),0);
 assert.equal(marketSimilarity('MM Wien 13 Hietzing','MM Wien 14 Hietzing'),0);
 assert.equal(marketSimilarity('Musterstrasse 12','Musterstrasse 1/2'),0);
 assert.equal(matchRosterMarket('MM Musterstadt Hauptstrasse 1A',[reference]).entries.length,1);
 assert.equal(matchRosterMarket('MM Musterstdt Hauptstrasse 1A',[reference]).entries.length,1);
 assert.equal(matchRosterMarket('MM Wels',[{...reference,market:'Media Markt Wels'}]).entries.length,1);
 assert.equal(marketSimilarity('MM Musterstadt Zentrum','MM Musterstadt Zentrum Nord'),.92);
 assert.equal(matchRosterMarket('MM Musterstadt Zentrum',[{...reference,market:'MM Musterstadt Zentrum Nord'},{...reference,id:'r2',market:'MM Musterstadt Zentrum Sued'}]).ambiguous,true);
});
test('similar branches, multiple people and unlinked roster rows never become arbitrary matches',()=>{
 const two=[reference,{...reference,id:'r2',person_id:'b'}];
 assert.equal(resolveImportPeople([source()],[person],[assignment],'HE','full',{},two,'2026-10').unresolvedCount,1);
 assert.equal(resolveImportPeople([source()],[person],[assignment],'HE','full',{},[{...reference,person_id:null}],'2026-10').unresolvedCount,1);
 const branches=[{...reference,market:'Musterstadt Zentrum West'},{...reference,id:'r2',market:'Musterstadt Zentrum Ost'}];
 assert.equal(matchRosterMarket('Musterstadt Zentrum Wst',branches).ambiguous,true);
});
test('a maintained roster resolves name-less/placeholder feeds and stays within category, setting and report period',()=>{
 const result=resolveImportPeople([source()],[person],[assignment],'HE','full',{},[reference],'2026-10');
 assert.equal(result.matches[0].method,'roster');assert.equal(result.records[0].externalId,'SEC-A');
 assert.equal(resolveImportPeople([source()],[person],[assignment],'IM','full',{},[reference],'2026-10').unresolvedCount,1);
 assert.equal(resolveImportPeople([source()],[person],[assignment],'HE','full',{},[reference],'2026-09').unresolvedCount,1);
 assert.equal(resolveImportPeople([source()],[person],[{...assignment,setting:'vc'}],'HE','full',{},[reference],'2026-10').unresolvedCount,1);
 const conflicting={...source(),externalId:'SEC-A',name:'Different Person'};
 assert.equal(resolveImportPeople([conflicting],[person],[assignment],'HE','full',{},[reference],'2026-10').unresolvedCount,1);
 const doubled=resolveImportPeople([source()],[person],[assignment],'HE','full',{'2':'a'},[reference],'2026-10',new Set([2]));
 assert.equal(doubled.unresolvedCount,1);
});
test('latest database snapshot applies only from its source month and does not rewrite old periods',()=>{
 const later={...reference,id:'new',source_month:'2026-11',imported_at:'2026-11-18T10:00:00Z'};
 const correction={...reference,id:'corrected',imported_at:'2026-11-18T09:00:00Z'};
 assert.equal(rosterForMonth([reference,later,correction],'HE','2026-10')[0].id,'corrected');
 assert.equal(rosterForMonth([reference,later,correction],'HE','2026-11')[0].id,'new');
 assert.deepEqual(rosterForMonth([reference],'HE','2026-09'),[]);
});
test('roster parsing selects required headers only, ignores supervisor values and reports field locations without values',()=>{
 const header={row:1,cells:{A:v('Nachname'),B:v('Vorname'),C:v('Division'),D:v('Email'),E:v('Markt'),F:v('Zuständiger SV')}};
 const input={row:2,cells:{A:v('Beispiel'),B:v('Anna'),C:v('HA'),D:v('anna@example.invalid'),E:v('MM Musterstadt'),F:v('DO NOT COPY')}};
 const parsed=parseRoster([{allRows:[header,input]}]);assert.equal(parsed.records[0].department_id,'DA');assert.equal(parsed.records[0].source_row,2);
 assert.ok(!JSON.stringify(parsed).includes('DO NOT COPY'));assert.equal(parsed.headers.length,5);
 const invalid={...input,cells:{...input.cells,D:v('PRIVATE_INVALID_EMAIL')}};
 const bad=parseRoster([{allRows:[header,invalid]}]);assert.ok(bad.issues.length);assert.ok(!JSON.stringify(bad.issues).includes('PRIVATE_INVALID_EMAIL'));
 assert.throws(()=>parseRoster([{allRows:[]}]),/Überschriften/);
});
const ctx={group:'HE',setting:'full',month:'2026-10',asOf:'2026-10-29',phase:'WEEKLY_PROGRESS',configurationVersion:'test',metrics:[{id:'units',label:'TV Units',active:true,unit:'Stück',block:'Sell-out',dataset:'sellout',weight:100,target:10,actual:0}]};
test('weekly: blank legacy SEC fields are restored by roster; explicit vacancies and two-person HOURS are preserved',()=>{
 const maps=[['A','person.externalId','identity','text'],['B','person.name','identity','text'],['C','assignment.market','assignment','text'],['D','units.target','sellout','number'],['E','units.actual','sellout','number']].map(([column,field,dataset,dataType])=>({column,field,dataset,dataType,sourceLabel:field,required:true}));
 const row={row:2,cells:{A:v(''),B:v(''),C:v('MM Musterstadt Hauptstrasse 1A'),D:v(10),E:v(-2),F:v('35')}};
 const sheet={name:'Weekly',columns:[...maps.map(m=>({key:m.column,label:m.sourceLabel})),{key:'F',label:'HOURS'}],allRows:[],data:[row]};
 const result=prepareImport(sheet,maps,ctx,[person],[assignment],{},[reference]);assert.deepEqual(result.issues,[]);assert.equal(result.records.length,1);assert.equal(result.skippedUnstaffed,0);assert.equal(result.records[0].normalized.metrics[0].actual,-2);
 const doubled=prepareImport({...sheet,data:[{...row,cells:{...row.cells,F:v('35 + 35')}}]},maps,ctx,[person],[assignment],{},[reference]);assert.equal(doubled.unresolvedCount,1);assert.equal(doubled.records.length,0);
 const vacant=prepareImport({...sheet,data:[{...row,cells:{...row.cells,B:v('No SEC')}}]},maps,ctx,[person],[assignment],{},[reference]);assert.equal(vacant.skippedUnstaffed,1);
});
test('monthly Pivot: a blank SEC ID resolves from the same roster while figures/months are unchanged',()=>{
 const template=closingTemplate('HE'),maps=closingMappings(template,'HE');
 const cells=Object.fromEntries(maps.filter(m=>m.dataset!=='ignore'&&m.column).map(m=>[m.column,v(m.dataType==='text'?'source':m.dataType==='date'?'2026-10-01':1)]));
 for(const [field,value]of [['person.externalId',''],['person.name',''],['assignment.market','MM Musterstadt Hauptstrasse 1A'],['snapshot.reportMonth','2026-10-01']])cells[maps.find(m=>m.field===field).column]=v(value);
 const result=prepareImport({...template,allRows:[],data:[{row:3,cells}]},maps,{...ctx,phase:'MONTH_FINALIZATION'},[person],[assignment],{},[reference]);
 assert.deepEqual(result.issues,[]);assert.equal(result.records[0].externalId,'SEC-A');assert.equal(result.records[0].normalized.month,'2026-10');
});
