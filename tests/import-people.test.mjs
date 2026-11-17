import test from 'node:test';
import assert from 'node:assert/strict';
import {importPeopleOptions} from '../src/importPeople.ts';
import {resolveImportPeople} from '../src/identity.ts';
import {resolveRecipients} from '../src/recipients.ts';

const people=['a','b','c','d','old1','old2','vc','im','lh'].map(id=>({id,external_id:'QA-'+id,name:'Beispiel '+id}));
const assignment=(id,department_id='DA',setting='full')=>({person_id:id,department_id,setting,market:'MM Musterstadt 1'});
const assignments=[...people.slice(0,6).map(p=>assignment(p.id)),assignment('vc','DA','vc'),assignment('im','IM'),assignment('lh','LH')];
const ref=(id,department_id='DA',source_month='2026-10',imported_at='2026-11-17T10:00:00Z')=>({id:'ref-'+id+source_month+imported_at,person_id:id,department_id,market:'MM Musterstadt 1',source_month,source_hash:'a'.repeat(64),imported_at});
const current=['a','b','c','d'].map(id=>ref(id));
const ctx={group:'DA',setting:'full',month:'2026-11',phase:'WEEKLY_PROGRESS',asOf:'2026-11-10'};
const row={row:2,name:'',externalId:'',market:'MM Musterstadt 1',fields:{},normalized:{},sourceShopId:null};
const ids=options=>options.map(p=>p.id).sort();

test('current HA list offers four roster people, excluding two former people and other settings/divisions',()=>{
 const before=JSON.stringify({people,assignments,current});
 assert.deepEqual(ids(importPeopleOptions(people,assignments,current,ctx)),['a','b','c','d']);
 assert.deepEqual(importPeopleOptions(people,assignments,current,{...ctx,setting:'vc'}),[]);
 assert.equal(JSON.stringify({people,assignments,current}),before);
});
test('historical imports use the roster valid then, with latest corrections but no future backdating',()=>{
 const old=['old1','old2'].map(id=>ref(id,'DA','2026-08'));
 assert.deepEqual(ids(importPeopleOptions(people,assignments,[...old,...current],{...ctx,month:'2026-09'})),['old1','old2']);
 const corrected=[ref('old1','DA','2026-10','2026-11-18T10:00:00Z')];
 assert.deepEqual(ids(importPeopleOptions(people,assignments,[...current,...corrected],ctx)),['old1']);
 // No reference exists yet for this old month: preserve historical division assignments.
 assert.deepEqual(ids(importPeopleOptions(people,assignments,current,{...ctx,month:'2026-09'})),['a','b','c','d','old1','old2']);
});
test('old identities cannot bypass current selection through ID, name, manual choice or new-person selection',()=>{
 for(const choice of [undefined,'old1','new']){
  const result=resolveImportPeople([{...row,name:'Beispiel old1',externalId:'QA-old1'}],people,assignments,'DA','full',choice?{'2':choice}:{},current,'2026-11');
  assert.equal(result.records.length,0);assert.equal(result.unresolvedCount,1);assert.equal(result.matches[0].canCreate,false);
 }
 const byName=resolveImportPeople([{...row,name:'Beispiel old1'}],people,assignments,'DA','full',{},current,'2026-11');
 assert.ok(!byName.records.some(r=>r.externalId==='QA-old1'));
 const historical=resolveImportPeople([{...row,externalId:'QA-old1'}],people,assignments,'DA','full',{},current,'2026-09');
 assert.equal(historical.records[0].externalId,'QA-old1');
});
test('wrong division and DA setting choices are rejected even without a roster; real new historic people stay possible',()=>{
 for(const id of ['vc','im','lh']){
  assert.equal(resolveImportPeople([row],people,assignments,'DA','full',{'2':id},[],'2026-09').unresolvedCount,1);
  assert.equal(resolveImportPeople([{...row,externalId:'QA-'+id}],people,assignments,'DA','full',{},[],'2026-09').unresolvedCount,1);
 }
 const unknown={...row,name:'Neue Beispielperson',externalId:'QA-new'};
 assert.equal(resolveImportPeople([unknown],people,assignments,'DA','full',{'2':'new'},current,'2026-11').unresolvedCount,1);
 assert.equal(resolveImportPeople([unknown],people,assignments,'DA','full',{'2':'new'},current,'2026-09').matches[0].status,'new');
});
test('weekly LH choices remain available while monthly and regular rows stay in their own division',()=>{
 const refs=[ref('im','IM'),ref('lh','LH')];
 const im={...ctx,group:'IM'};
 assert.deepEqual(ids(importPeopleOptions(people,assignments,refs,im)),['im','lh']);
 assert.deepEqual(ids(importPeopleOptions(people,assignments,refs,{...im,phase:'MONTH_FINALIZATION'})),['im']);
 const match=resolveRecipients([{...row,externalId:'QA-im'}],people,assignments,im,{},refs,new Map()).matches[0];
 assert.deepEqual(match.targetGroups,['IM']);
});
test('shared market recipients cannot reintroduce a former employee by a forged manual array',()=>{
 const refs=[ref('a'),ref('b')];
 const good=resolveRecipients([row],people,assignments,ctx,{'2':['a','b']},refs,new Map([[2,{count:2,lighthouse:false}]]));
 assert.equal(good.records.length,2);assert.equal(good.unresolvedCount,0);
 const wrong=resolveRecipients([row],people,assignments,ctx,{'2':['a','old1']},refs,new Map([[2,{count:2,lighthouse:false}]]));
 assert.equal(wrong.records.length,0);assert.equal(wrong.unresolvedCount,1);
});
