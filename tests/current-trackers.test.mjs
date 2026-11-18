import test from 'node:test';
import assert from 'node:assert/strict';
import {weeklyMappings} from '../src/imports.ts';
import {prepareImport} from '../src/importPreparation.ts';

const v=value=>({kind:'value',value});
const ctx={group:'HE',setting:'full',month:'2026-11',asOf:'2026-11-16',phase:'WEEKLY_PROGRESS',configurationVersion:'test'};
const columns=Object.entries({C:'Store',D:'SEC',E:'HOURS',F:'TGT',L:'TTL',M:'T/A %',N:'TGT',T:'TTL',U:'T/A %',V:'TGT',AB:'TTL',AC:'T/A %',AD:'TGT %',AE:'IHS %',AF:'T/A %',AG:'Total T/A%'}).map(([key,label])=>({key,label}));
const p={id:'a',external_id:'QA-A',name:'Anna Beispiel'};
const assignment={person_id:'a',department_id:'HE',setting:'full',market:'MM Musterstadt Ost'};
const ref={id:'ref-a',person_id:'a',department_id:'HE',market:assignment.market,source_month:'2026-11',source_hash:'a'.repeat(64),imported_at:'2026-11-18T12:00:00Z'};
const sheet={name:'Result',headerRow:10,columns,allRows:[],data:[{row:11,cells:{C:v(assignment.market),D:v('HE'),E:v(35),F:v(50),L:v(12),N:v(20),T:v(-2),V:v(900),AB:v(1000),AD:v(.5),AE:v(.4),AG:v(.8)}}]};

test('HE monthly tracker maps cumulative totals, not a weekly column or achievement percentage',()=>{
 const mappings=weeklyMappings(sheet,ctx);
 assert.deepEqual(Object.fromEntries(mappings.filter(m=>/\.(target|actual)$/.test(m.field)).map(m=>[m.field,m.column])),{'units.target':'F','units.actual':'L','soundbar.target':'N','soundbar.actual':'T','asp.target':'V','asp.actual':'AB','share.target':'AD','share.actual':'AE'});
 const result=prepareImport(sheet,mappings,ctx,[p],[assignment],{},[ref]);
 assert.deepEqual(result.issues,[]);assert.equal(result.records.length,1);
 assert.deepEqual(result.records[0].normalized.metrics.map(m=>[m.key,m.target,m.actual]),[['units',50,12],['soundbar',20,-2],['asp',900,1000],['share',50,40]]);
 assert.equal(result.records[0].normalized.sellout,80);
 const unknown={...sheet,columns:columns.map(c=>c.key==='F'?{...c,label:'Unknown'}:c)};
 assert.equal(weeklyMappings(unknown,ctx).find(m=>m.field==='units.target').column,'');
 assert.equal(weeklyMappings({...sheet,columns:columns.map(c=>c.key==='AB'?{...c,label:'Unknown'}:c)},ctx).find(m=>m.field==='asp.actual').column,'');
});

const ha={...ctx,group:'DA',metrics:[{id:'laundry',label:'Laundry',active:true,unit:'Stück',block:'Sell-out',dataset:'sellout',weight:100,target:10,actual:0}]};
const haColumns=[{key:'C',label:'Store'},{key:'D',label:'SEC'},{key:'E',label:'HOURS'},{key:'F',label:'TGT'},{key:'L',label:'TTL'},{key:'AM',label:'Total T/A%'}];
const haAssignment={...assignment,department_id:'DA'};
const haRef={...ref,department_id:'DA'};
const haSheet={...sheet,columns:haColumns,data:[{row:11,cells:{C:v(assignment.market),D:v('HA-R+VC'),E:v('35+32,5'),F:v(10),L:v(5)}},{row:12,cells:{C:v('MM Former Market'),D:v('HA-R(ex. VC)'),E:v(30),F:{kind:'error',value:'#DIV/0!'},L:v('bad')}}]};

test('HA staffing labels use the current roster and skip former markets before validating their cells',()=>{
 const result=prepareImport(haSheet,weeklyMappings(haSheet,ha),ha,[p],[haAssignment],{},[haRef]);
 assert.deepEqual(result.issues,[]);assert.equal(result.records.length,1);assert.equal(result.records[0].externalId,p.external_id);
 assert.equal(result.skippedUnstaffed,1);assert.match(result.skippedRows[0].message,/Personenliste/);
 assert.equal(result.identityMatches[0].status,'matched');
 // A real unknown name is never silently removed merely because its market is absent.
 const unknown={...haSheet,data:[{...haSheet.data[1],cells:{...haSheet.data[1].cells,D:v('Unknown Person'),F:v(10),L:v(1)}}]};
 const review=prepareImport(unknown,weeklyMappings(unknown,ha),ha,[p],[haAssignment],{},[haRef]);
 assert.equal(review.skippedUnstaffed,0);assert.equal(review.unresolvedCount,1);
});

test('HA historical months do not use a future roster to remove people or reduce two-person staffing',()=>{
 const old={...ha,month:'2026-10',asOf:'2026-10-16'};
 const result=prepareImport(haSheet,weeklyMappings(haSheet,old),old,[p],[haAssignment],{},[haRef]);
 assert.equal(result.skippedUnstaffed,0);assert.ok(result.issues.some(i=>i.row===12));
 assert.equal(result.identityMatches.find(m=>m.row===11).expectedCount,2);
});

test('a stored HE update cannot make a blank HA market look staffed',()=>{
 const vacant={...haSheet,data:[{row:12,cells:{C:v('MM Former Market'),D:v(''),E:v(''),F:v(10),L:v(1)}}]};
 const previous=[{importId:'he-import',source:'HE',asOf:'2026-11-09',savedAt:'2026-11-10T10:00:00Z',status:'published',personId:'he-person',legacy:true,plan:{version:1,market:'MM Former Market',source:'HE',expected:{}}}];
 const result=prepareImport(vacant,weeklyMappings(vacant,ha),ha,[p],[haAssignment],{},[haRef],previous);
 assert.deepEqual(result.issues,[]);assert.equal(result.skippedUnstaffed,1);assert.equal(result.records.length,0);
});
