import test from 'node:test';import assert from 'node:assert/strict';
import {ownPremiumHistory} from '../src/premiumHistory.ts';
import {normalizeClosing} from '../src/imports.ts';
import {PROJECT_ASSESSMENT_ITEMS} from '../shared/projectAssessment.ts';
const row=(change={})=>({id:'source',person_id:'own',department_id:'IM',assignment_id:'market',month:'2026-01-01',revision:1,payload:{premium:100,extrasAvailable:true,extras:[{type:'On-top',amount:5}]},...change});
test('own premiums include previous own markets, active revisions only and never foreign people or divisions',()=>{
 const history=ownPremiumHistory([row(),row({assignment_id:'old-market',month:'2025-12-01'}),row({revision:2,payload:{premium:120,extrasAvailable:true,extras:[]}}),row({person_id:'foreign'}),row({department_id:'DA'})],'own','IM');
 assert.equal(history.length,2);assert.equal(history[0].month,'2025-12');assert.equal(history[1].premium,120);assert.deepEqual(history[1].extras,[]);assert.equal(history[1].extrasAvailable,true);
});
test('overlapping assignments count agreeing payouts once and preserve conflicting or missing payouts as unknown',()=>{
 const same=row({assignment_id:'another'});assert.equal(ownPremiumHistory([row(),same],'own','IM')[0].premium,100);
 const conflict=row({assignment_id:'another',payload:{premium:200,extrasAvailable:true,extras:[{type:'On-top',amount:10}]}});const result=ownPremiumHistory([row(),conflict],'own','IM')[0];assert.equal(result.premium,null);assert.equal(result.extrasAvailable,false);
 for(const bad of [null,NaN,Infinity,undefined])assert.equal(ownPremiumHistory([row({payload:{premium:bad}})],'own','IM')[0].premium,null);
 const zero=ownPremiumHistory([row({payload:{premium:0,extras:[],extrasAvailable:true}})],'own','IM')[0];assert.equal(zero.premium,0);assert(zero.extrasAvailable);
});
test('new monthly imports nest the supplied PL detail values without recomputing their summary',()=>{
 const keys=['softbonus.pl-bewertung',...PROJECT_ASSESSMENT_ITEMS.map(([key])=>key)];
 const fields=Object.fromEntries(keys.map((key,i)=>[key,{kind:'value',value:i===0?.93:i===1?0:1,sourceColumn:'Q'}]));
 fields[PROJECT_ASSESSMENT_ITEMS[1][0]]={kind:'blank',value:null,sourceColumn:'AG'};
 const result=normalizeClosing({row:3,fields,month:'2026-09'},{group:'IM',setting:'full',month:'2026-09',phase:'MONTH_FINALIZATION',asOf:'2026-09-30',configurationVersion:'test'}).normalized;
 assert.equal(result.qualitative.length,1);const parent=result.qualitative[0];assert.equal(parent.achievement,93);assert.equal(parent.details.length,6);assert.equal(parent.details[0].achievement,0);assert.equal(parent.details[1].achievement,null);assert.equal(parent.details[1].resultState,'missing');
});
