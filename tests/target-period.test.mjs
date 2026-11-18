import test from 'node:test';import assert from 'node:assert/strict';
import {sourceTargetPeriod,sourceCampaignMonth,validateContext,validateWeekly} from '../src/imports.ts';
import {supervisorGroup} from '../src/supervisorGroup.ts';
const period={from:'2026-09-28',through:'2026-11-01'},v=value=>({kind:'value',value});
const ctx={group:'IM',setting:'full',month:'2026-10',asOf:'2026-10-15',phase:'WEEKLY_PROGRESS',configurationVersion:'source',targetPeriod:period,metrics:[{id:'units',label:'Units',unit:'Stück',weight:100,active:true,dataset:'sellout',block:'IM'}]};
test('target metadata is validated and retained without altering signed source values',()=>{
 assert.doesNotThrow(()=>validateContext(ctx));
 assert.doesNotThrow(()=>validateContext({...ctx,targetPeriod:{from:'2027-01-01',through:'2027-01-02'}}));
 assert.throws(()=>validateContext({...ctx,targetPeriod:{from:'2026-11-01',through:'2026-09-28'}}),/Zielzeitraum/);
 assert.throws(()=>validateContext({...ctx,phase:'MONTH_FINALIZATION'}),/Zielzeitraum/);
 const mappings=[['A','person.name','text'],['B','assignment.market','text'],['C','units.target','number'],['D','units.actual','number']].map(([column,field,dataType])=>({column,field,dataType,sourceLabel:field,required:false,dataset:'sellout'}));
 const sheet={name:'Weekly',headerRow:2,columns:mappings.map(m=>({key:m.column,label:m.sourceLabel})),allRows:[{row:1,cells:{A:v('IM SEC Monthly 202610 (28.09. - 01.11.2026)')}}],data:[{row:3,cells:{A:v('Synthetic SEC'),B:v('Synthetic Market'),C:v(50),D:v(-2)}}]};
 assert.deepEqual(sourceTargetPeriod(sheet),period);assert.equal(sourceCampaignMonth(sheet),'2026-10');
 sheet.allRows.push({row:1,cells:{B:v('EDI Data period 28.09.2026 - 15.10.2026')}});assert.deepEqual(validateWeekly(sheet,mappings,ctx).issues,[]);assert(validateWeekly(sheet,mappings,{...ctx,month:'2026-11'}).issues.some(i=>/Kampagnenmonat/.test(i.message)));sheet.allRows.pop();
 const result=validateWeekly(sheet,mappings,ctx);assert.deepEqual(result.issues,[]);assert.deepEqual(result.records[0].normalized.targetPeriod,period);assert.equal(result.records[0].normalized.metrics[0].actual,-2);
 const {targetPeriod:excluded,...legacy}=ctx;assert.equal('targetPeriod' in validateWeekly(sheet,mappings,legacy).records[0].normalized,false);
});
test('group means retain informational dates and compare all paired weekly values',()=>{
 const row=(person,day,period)=>({id:person+day,person_id:person,assignment_id:person,department_id:'IM',month:'2026-10-01',revision:1,published_at:'2026-10-'+day+'T08:00:00Z',as_of:'2026-10-'+day,payload:{setting:'full',targetPeriod:period,metrics:[{key:'units',label:'Units',unit:'Stück',weight:100,actual:Number(day),target:50}]}});
 const changed={from:'2027-01-01',through:'2027-01-02'},weekly=[row('a','08',period),row('b','08',undefined),row('a','15',changed),row('b','15',undefined)];
 const source={members:['a','b'].map(person_id=>({person_id,setting:'full'})),reports:[],premiumRows:[],pointHistory:[],weekly};
 const stands=supervisorGroup(source,'IM','2026-10-20').weekly.stands;
 assert.deepEqual(stands[1].metrics[0].targetPeriodCoverage,{period:changed,known:1,total:2,different:false});
 assert.deepEqual(stands[1].metrics[0].change,{value:7,known:2,total:2});
 assert.equal(stands[1].metrics[0].actual.value,15);
 assert.equal(supervisorGroup(source,'IM','2026-10-09').weekly.stands[0].metrics[0].actual.value,8);
 assert.equal(supervisorGroup(source,'IM','2026-10-31').weekly.stands[1].metrics[0].actual.value,15);
});
