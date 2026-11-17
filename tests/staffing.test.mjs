import test from 'node:test';import assert from 'node:assert/strict';
import {prepareImport} from '../src/importPreparation.ts';
import {planMarketStaffing,staffingProgress,matchingStaffing,staffingOverview} from '../src/staffing.ts';
const v=value=>({kind:'value',value});
const market='Media Markt Musterstadt Hauptstraße 1a';
const people=[{id:'he',external_id:'HE-1',name:'Synthetic HE'},{id:'im',external_id:'IM-1',name:'Synthetic IM'}];
const assignments=people.map(p=>({person_id:p.id,department_id:p.id.toUpperCase(),setting:'full',market}));
const reference=people.map(p=>({id:'ref-'+p.id,person_id:p.id,department_id:p.id.toUpperCase(),market,source_month:'2026-10',source_hash:'a'.repeat(64),imported_at:'2026-11-17T10:00:00Z'}));
const mappings=[['A','person.externalId','identity','text'],['B','person.name','identity','text'],['C','assignment.market','assignment','text'],['D','units.target','sellout','number'],['E','units.actual','sellout','number']].map(([column,field,dataset,dataType])=>({column,field,dataset,dataType,sourceLabel:field,required:true}));
const sheet={name:'Weekly',columns:[...mappings.map(m=>({key:m.column,label:m.sourceLabel})),{key:'F',label:'HOURS'},{key:'G',label:'Type'}],allRows:[],data:[{row:2,cells:{A:v(''),B:v(''),C:v('MM Musterstadt Hauptstrasse 1A'),D:v(50),E:v(10),F:v('35+35'),G:v('Full')}}]};
const ctx={group:'HE',setting:'full',month:'2026-10',asOf:'2026-10-07',phase:'WEEKLY_PROGRESS',configurationVersion:'test',metrics:[{id:'units',label:'Units',active:true,unit:'Stück',block:'Test',dataset:'sellout',weight:100}]};
const stored=(record,group='HE',overrides={})=>({importId:group+'-batch',source:group,asOf:ctx.asOf,savedAt:'2026-11-17T11:00:00Z',status:'draft',personId:group.toLowerCase(),plan:record.normalized.staffing,...overrides});
test('one HE and one IM means one recipient in the HE file, with the IM side explicitly waiting',()=>{
 const result=prepareImport(sheet,mappings,ctx,people,assignments,{},reference);assert.deepEqual(result.issues,[]);assert.equal(result.records.length,1);assert.equal(result.records[0].externalId,'HE-1');assert.equal(result.identityMatches[0].expectedCount,1);
 assert.deepEqual(result.records[0].normalized.staffing.expected,{HE:1,IM:1});assert.equal(result.identityMatches[0].staffing.sources.find(s=>s.division==='IM').status,'awaiting');assert.equal(result.records[0].normalized.groupId,'HE');
});
test('a later IM file remembers the saved HE side, emits only IM values and completes without asking for another HE',()=>{
 const first=prepareImport(sheet,mappings,ctx,people,assignments,{},reference),previous=JSON.parse(JSON.stringify([stored(first.records[0])]));
 const later=prepareImport(sheet,mappings,{...ctx,group:'IM'},people,assignments,{},reference,previous);assert.deepEqual(later.issues,[]);assert.equal(later.records.length,1);assert.equal(later.records[0].externalId,'IM-1');assert.equal(later.records[0].normalized.groupId,'IM');assert.equal(later.records[0].normalized.sourceGroup,undefined);
 assert.equal(later.identityMatches[0].staffing.sources.find(s=>s.division==='HE').status,'draft');
 const both=[...previous,stored(later.records[0],'IM',{status:'published'})];const progress=staffingProgress(later.records[0].normalized.staffing,both,ctx.asOf);assert.equal(progress.complete,true);assert.deepEqual(progress.sources.map(s=>s.receivedPeople),[1,1]);
});
test('an explicit Lighthouse type can wait for the other roster entry; missing identity remains reviewable',()=>{
 const singleRef=[reference[0]],lighthouse={...sheet,data:[{...sheet.data[0],cells:{...sheet.data[0].cells,G:v('TV Lighthouse')}}]};
 const first=prepareImport(lighthouse,mappings,ctx,people,assignments,{},singleRef);assert.deepEqual(first.issues,[]);assert.equal(first.records.length,1);
 const incoming={...sheet,data:[{...sheet.data[0],cells:{...sheet.data[0].cells,F:v(''),G:v(''),A:v('IM-1'),B:v('Synthetic IM')}}]};
 const later=prepareImport(incoming,mappings,{...ctx,group:'IM'},people,assignments,{},singleRef,[stored(first.records[0])]);assert.deepEqual(later.issues,[]);assert.equal(later.records[0].externalId,'IM-1');
 const unknown=prepareImport({...incoming,data:[{...incoming.data[0],cells:{...incoming.data[0].cells,A:v(''),B:v('Unknown Person')}}]},mappings,{...ctx,group:'IM'},people,[],{},singleRef,[stored(first.records[0])]);assert.equal(unknown.unresolvedCount,1);assert.equal(unknown.skippedUnstaffed,0);
});
test('two HE remain two HE; same-market IM elsewhere does not reduce a proven two-HE row',()=>{
 const more=[...reference,{...reference[0],id:'he2',person_id:'he2'}];assert.equal(planMarketStaffing(market,ctx,2,false,more,[]),null);
});
test('component memory is correction-safe, excludes future dates and does not invent unauthorized progress',()=>{
 const plan=planMarketStaffing(market,ctx,2,false,reference,[]),first={...stored({normalized:{staffing:plan}}),status:'published'};
 const correction={...first,importId:'correction',savedAt:'2026-11-17T12:00:00Z',status:'draft'};
 const progress=staffingProgress(plan,[first,first,correction],ctx.asOf);assert.equal(progress.sources[0].receivedPeople,1);assert.equal(progress.sources[0].status,'draft');assert.equal(progress.complete,false);
 assert.equal(matchingStaffing(market,[{...first,asOf:'2026-10-14'}],ctx.asOf).length,0);
 assert.equal(matchingStaffing('MM Musterstadt Hauptstrasse 2',[first],ctx.asOf).length,0);
 const limited=staffingProgress(plan,[first],ctx.asOf,['HE']);assert.equal(limited.sources[1].status,'restricted');assert.equal(limited.complete,false);
});

test('older imports confirm a received side without manufacturing a new mixed-division market',()=>{
 const plan=planMarketStaffing(market,ctx,2,false,reference,[]);
 const legacy={...stored({normalized:{staffing:plan}}),legacy:true,plan:{...plan,expected:{}}};
 assert.deepEqual(staffingOverview([legacy],ctx.asOf,['HE','IM']),[]);
 assert.equal(planMarketStaffing(market,ctx,2,false,[],[legacy]),null);
 assert.equal(staffingProgress(plan,[legacy],ctx.asOf).sources[0].receivedPeople,1);
});
