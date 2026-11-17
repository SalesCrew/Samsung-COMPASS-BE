import test from 'node:test';
import assert from 'node:assert/strict';
import {hePresentation,imPresentation,secPresentation} from '../src/presentation.ts';
import {HE_METRICS,performanceTier} from '../shared/groups.ts';
const profile={user_id:'he-demo',person_id:null,is_test:true,role:'sec',primary_department:'HE'};
const settings={personId:'virtual-he-person',assignmentId:'virtual-he-market',market:'Media Markt Mustermann',readIds:[]};
test('HE presentation requires a dedicated unlinked HE SEC account and its own virtual assignment',()=>{
 for(const change of [{person_id:'employee'},{is_test:false},{role:'app_admin'},{role:'supervisor'},{primary_department:'IM'},{primary_department:null}])
  assert.throws(()=>hePresentation({...profile,...change},settings,'2026-11-17'));
 assert.throws(()=>hePresentation(profile,settings,'2026-11-17','another-assignment'));
 assert.throws(()=>secPresentation({...profile,primary_department:'DA'},settings,'2026-11-17'));
 assert.throws(()=>imPresentation(profile,settings,'2026-11-17'));
 assert.equal(profile.person_id,null);
});
test('HE sample has correct TV KPIs, coherent results, levels, premiums and criterion details',()=>{
 const data=secPresentation(profile,settings,'2026-11-17');
 assert.equal(data.presentation,true);assert.equal(data.reports.length,24);assert.equal(data.premiumHistory.length,24);
 assert.deepEqual(data.assignments,[{id:settings.assignmentId,person_id:settings.personId,department_id:'HE',setting:'full',market:settings.market,active:true}]);
 for(const row of data.reports){
  assert.equal(row.department_id,'HE');assert.equal(row.import_id,'presentation-only');assert.equal(row.person_id,settings.personId);
  assert.equal(row.payload.groupId,'HE');
  assert.deepEqual(row.payload.metrics.map(m=>m.key),HE_METRICS.map(m=>m.key));
  for(const m of row.payload.metrics)assert.equal(m.achievement,Math.round(m.actual/m.target*1000)/10);
  const share=row.payload.metrics.find(m=>m.key==='share');assert(share.actual>=0&&share.actual<=100);
  assert.equal(row.payload.points,{gold:3,silver:2,bronze:1}[performanceTier('HE',row.payload.sellout,row.payload.softbonus)]);
  assert.equal(row.payload.qualitative.find(m=>m.key==='project').details.length,6);
  assert.equal(row.payload.qualitative.find(m=>m.key==='reporting').label,'Reporting / Surveys / Planogramm');
 }
});
test('HE presentation keeps complete weekly history and stable snapshot over calendar changes',()=>{
 const data=hePresentation(profile,settings,'2026-11-17');
 assert.equal(data.calendarDay,'2026-10-30');assert.equal(data.realCalendarDay,'2026-11-17');
 assert.equal(data.reports.at(-1).month,'2026-09-01');assert.equal(data.weekly.length,5);
 assert(data.weekly[0].payload.metrics.every(m=>m.actual===null));
 assert.equal(data.weekly.at(-1).department_id,'HE');
 assert(data.weekly.at(-1).payload.metrics.find(m=>m.key==='units').actual>data.weekly.at(-2).payload.metrics.find(m=>m.key==='units').actual);
 assert.equal(data.weekly.at(-1).payload.metrics.find(m=>m.key==='share').actual,49);
 for(const day of ['2026-12-01','2027-01-16']){
  const later=hePresentation(profile,settings,day);
  assert.deepEqual(later.reports,data.reports);assert.deepEqual(later.weekly,data.weekly);
 }
 const own=data.reports.at(-1).id;
 assert.deepEqual(hePresentation(profile,{...settings,readIds:[own,'other-report']},'2026-11-17').read,[{report_id:own}]);
});
