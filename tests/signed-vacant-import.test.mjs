import test from 'node:test';import assert from 'node:assert/strict';
import {prepareImport,exclusionFingerprint,skippedImportRows} from '../src/importPreparation.ts';
import {validateWeekly,normalizeClosing,weeklyMappings} from '../src/imports.ts';
import {closingMappings,closingTemplate,prepareClosing} from '../shared/closingImport.ts';
const v=value=>({kind:'value',value}),blank={kind:'blank',value:null};
const ctx={group:'HE',setting:'full',month:'2026-10',asOf:'2026-10-29',phase:'WEEKLY_PROGRESS',configurationVersion:'test',metrics:[{id:'units',label:'TV Units',active:true,unit:'Stück',block:'Sell-out',dataset:'sellout',weight:100,target:10,actual:0}]};
const people=[{id:'a',name:'Anna Test',external_id:'SEC-A'},{id:'b',name:'Berta Test',external_id:'SEC-B'}],assignments=people.map(p=>({person_id:p.id,department_id:'HE',setting:'full',market:'Market '+p.id}));
const mappings=[['A','person.externalId','identity','text'],['B','person.name','identity','text'],['C','assignment.market','assignment','text'],['D','units.target','sellout','number'],['E','units.actual','sellout','number']].map(([column,field,dataset,dataType])=>({column,field,dataset,dataType,sourceLabel:field,required:true}));
const row=(n,id,name,market,actual=-3,target=10)=>({row:n,cells:{A:v(id),B:v(name),C:v(market),D:v(target),E:v(actual)}});
const sheet=(data,name='Weekly')=>({name,dimension:'A1:E100',rows:data.length+1,columns:mappings.map(m=>({key:m.column,label:m.sourceLabel})),headerRow:1,date1904:false,data,allRows:[]});
test('signed weekly numbers, German decimals, Unicode minus and percentages retain the original sign',()=>{
 for(const actual of [-3,'-3','-3,5','−3,5']){const result=validateWeekly(sheet([row(2,'SEC-A','Anna Test','Market a',actual)]),mappings,ctx);assert.deepEqual(result.issues,[]);assert.equal(result.records[0].normalized.metrics[0].actual,typeof actual==='number'?actual:actual.includes('5')?-3.5:-3);}
 const percent=mappings.map(m=>m.field==='units.actual'?{...m,dataType:'percent'}:m);assert.equal(validateWeekly(sheet([row(2,'SEC-A','Anna Test','Market a','-3 %')]),percent,ctx).records[0].normalized.metrics[0].actual,-3);
 assert.ok(validateWeekly(sheet([row(2,'SEC-A','Anna Test','Market a',-3,-1)]),mappings,ctx).issues.some(i=>/Monatsziel/.test(i.message)));
 assert.ok(validateWeekly(sheet([row(2,'SEC-A','Anna Test','Market a',-3)]),mappings,{...ctx,phase:'TARGET_INITIALIZATION'}).issues.some(i=>/Targetbasis/.test(i.message)));
});
test('vacant rows are skipped before cell errors/duplicates, unknown named people remain blocking',()=>{
 const input=sheet([row(2,'SEC-A','Anna Test','Market a',-2),row(3,'','','Market vacant','broken',null),row(4,'','No SEC','Other vacant','broken',null),row(5,'UNKNOWN','Unknown Person','Market unknown')]);
 const result=prepareImport(input,mappings,ctx,people,assignments);assert.equal(result.records.length,1);assert.equal(result.records[0].normalized.metrics[0].actual,-2);assert.equal(result.skippedUnstaffed,2);assert.equal(result.unresolvedCount,1);assert.ok(result.issues.every(i=>i.row===5));assert.equal(result.identityMatches.filter(m=>m.status==='skipped').length,2);
 const manual=prepareImport(input,mappings,ctx,people,assignments,{'5':'skip'});assert.deepEqual(manual.issues,[]);assert.equal(manual.records.length,1);assert.equal(manual.skippedManual,1);assert.notDeepEqual(exclusionFingerprint(result.skippedRows),exclusionFingerprint(manual.skippedRows));
 const repeat=prepareImport(input,mappings,ctx,people,assignments,{'5':'skip'});assert.deepEqual(exclusionFingerprint(manual.skippedRows),exclusionFingerprint(repeat.skippedRows));
});
test('known IDs, unreadable identity cells, unlisted IDs and market-only feeds are not silently discarded',()=>{
 const data=[row(2,'SEC-A','No SEC','Market a'),row(3,'UNKNOWN','','Market unknown'),row(4,'','','Market broken')];data[2].cells.B={kind:'uncached-formula',value:null};
 assert.equal(skippedImportRows(sheet(data),mappings,ctx,people).length,0);
 const marketOnly=mappings.filter(m=>!m.field.startsWith('person.'));assert.equal(skippedImportRows(sheet([row(2,'','','Market a')]),marketOnly,ctx,people).length,0);assert.equal(prepareImport(sheet([row(2,'','','Market a')]),marketOnly,ctx,people,assignments).records[0].externalId,'SEC-A');
 // Explicitly choosing a person restores a blank-SEC row; a different real name still needs review.
 assert.equal(skippedImportRows(sheet([row(2,'','','Market a')]),mappings,ctx,people,{'2':'a'}).length,0);
 assert.equal(prepareImport(sheet([row(2,'','','Market a')]),mappings,ctx,people,assignments,{'2':'a'}).records[0].externalId,'SEC-A');
 assert.equal(prepareImport(sheet([row(2,'SEC-A','Different Person','Market a')]),mappings,ctx,people,assignments).unresolvedCount,1);
});
test('all-vacant inputs create no records and no source errors; explicit skips can exclude a corrupt row',()=>{
 const result=prepareImport(sheet([row(2,'','','Market vacant','bad',null)]),mappings,ctx,people,assignments);assert.deepEqual(result.records,[]);assert.deepEqual(result.issues,[]);assert.equal(result.skippedUnstaffed,1);
 const broken=row(2,'SEC-A','Anna Test','Market a');broken.cells.B={kind:'error',value:'#REF!'};
 assert.equal(prepareImport(sheet([broken]),mappings,ctx,people,assignments,{'2':'skip'}).skippedManual,1);
});
test('historical closing values stay signed; No SEC rows are excluded before required-cell validation',()=>{
 const s=closingTemplate('HE'),maps=closingMappings(s,'HE');
 const personId=maps.find(m=>m.field==='person.externalId'),personName=maps.find(m=>m.field==='person.name'),market=maps.find(m=>m.field==='assignment.market'),month=maps.find(m=>m.field==='snapshot.reportMonth'),achievement=maps.find(m=>m.field==='units.achievement');
 const cells=Object.fromEntries(maps.filter(m=>m.dataset!=='ignore'&&m.column).map(m=>[m.column,v(m.dataType==='text'?'source':m.dataType==='date'?'2026-10-01':1)]));
 Object.assign(cells,{[personId.column]:v('SEC-A'),[personName.column]:v('Anna Test'),[market.column]:v('Market a'),[month.column]:v('2026-10-01'),[achievement.column]:v('-3,5%')});
 const vacant={...cells,[personName.column]:v('No SEC'),[personId.column]:v('source-shop-vacant'),[market.column]:v('Empty market'),[achievement.column]:{kind:'error',value:'#DIV/0!'}};
 const source={...s,data:[{row:3,cells},{row:4,cells:vacant}],allRows:[]},context={...ctx,phase:'MONTH_FINALIZATION'};
 const result=prepareImport(source,maps,context,people,assignments);assert.equal(result.records.length,1);assert.equal(result.skippedUnstaffed,1);assert.deepEqual(result.issues,[]);assert.equal(result.records[0].normalized.metrics[0].achievement,-3.5);
 const parsed=prepareClosing({...s,data:[{row:3,cells}]},'HE',maps,'2026-10');assert.equal(normalizeClosing(parsed.records[0],context).normalized.metrics[0].achievement,-3.5);
});
test('SEC tracker header is recognized as a name source',()=>{const s=sheet([]);s.columns[1].label='SEC';assert.equal(weeklyMappings(s,ctx).find(m=>m.field==='person.name').column,'B');});
