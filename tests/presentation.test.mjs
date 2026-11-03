import test from 'node:test';import assert from 'node:assert/strict';
import {imPresentation} from '../src/presentation.ts';
const profile={user_id:'synthetic-account',person_id:null,is_test:true,role:'sec',primary_department:'IM'};
const settings={personId:'synthetic-person',assignmentId:'synthetic-market',market:'Media Markt Mustermann',readIds:[]};
test('presentation uses only a dedicated unlinked IM test account and its own assignment',()=>{
 for(const change of [{is_test:false},{role:'app_admin'},{primary_department:'HE'},{person_id:'real-person'}])assert.throws(()=>imPresentation({...profile,...change},settings,'2026-10-30'));
 assert.throws(()=>imPresentation(profile,settings,'2026-10-30','foreign-market'));
 const d=imPresentation(profile,settings,'2026-10-30');assert.equal(d.profile.person_id,settings.personId);assert.equal(profile.person_id,null);
 assert.equal(d.assignments[0].market,settings.market);assert.equal(d.presentation,true);assert.equal(d.testReplay,false);
 assert.ok(d.reports.every(r=>r.person_id===settings.personId&&r.assignment_id===settings.assignmentId&&r.import_id==='presentation-only'));
 assert.equal(d.rankings['2026-09'].rank,3);assert.equal(d.rankings['2026-09'].pool,28);
 assert.ok(Object.values(d.rankings).slice(0,11).every(r=>r.rank===null&&r.reason==='incomplete-history'));
 assert.ok(Object.values(d.rankings).slice(11).every(r=>r.rank===3&&!r.outsideTopTen));
});
test('presentation names the assessment for each requested example month without changing results',()=>{
 const d=imPresentation(profile,settings,'2026-10-30');
 const criterion=month=>d.reports.find(r=>r.payload.month===month).payload.qualitative.find(m=>m.key==='knowledge');
 assert.equal(criterion('2026-08').label,'Wissenstest');
 assert.equal(criterion('2026-09').label,'Mystery Shopping');
 assert.equal(criterion('2026-08').achievement,94);assert.equal(criterion('2026-09').achievement,94);
 assert.equal(criterion('2026-07').label,'Wissenstest / Mystery Shopping');
});
test('24 coherent closings have usable metrics, points, money and stable monthly identities',()=>{
 const d=imPresentation(profile,settings,'2026-10-30');assert.equal(d.reports.length,24);assert.equal(d.reports.at(-1).month,'2026-09-01');assert.equal(d.pointHistory.length,24);
 for(const r of d.reports){assert.equal(r.payload.metrics.length,6);assert.equal(r.payload.qualitative.length,3);
  for(const m of r.payload.metrics)assert.equal(m.achievement,Math.round(m.actual/m.target*1000)/10);
  assert.equal(r.payload.points,{gold:3,silver:2,bronze:1}[r.payload.tier]);assert.ok(Number.isFinite(r.payload.premium)&&r.payload.premium>0);assert.equal(r.payload.extrasAvailable,true);
 }
 assert.equal(new Set(d.reports.map(r=>r.id)).size,24);assert.equal(new Set(d.reports.map(r=>r.payload.premium)).size>3,true);
 const next=imPresentation(profile,settings,'2026-11-16');for(const r of d.reports.slice(1))assert.deepEqual(next.reports.find(x=>x.id===r.id),r);
 const known=d.reports.at(-1).id;assert.deepEqual(imPresentation(profile,{...settings,readIds:[known,'foreign-report']},'2026-10-30').read,[{report_id:known}]);
});
test('presentation stays on its approved October snapshot across month and year changes',()=>{
 const baseline=imPresentation(profile,settings,'2026-10-30');
 const expected=['2026-10-01','2026-10-08','2026-10-15','2026-10-22','2026-10-29'];
 for(const day of ['2026-10-31','2026-11-01','2026-11-03','2026-11-15','2027-01-03','2027-02-28']){
  const data=imPresentation(profile,settings,day);
  assert.equal(data.calendarDay,'2026-10-30');assert.equal(data.realCalendarDay,day);
  assert.equal(data.reports.at(-1).month,'2026-09-01');
  assert.deepEqual(data.reports,baseline.reports);assert.deepEqual(data.weekly,baseline.weekly);
  assert.deepEqual(data.weekly.map(w=>w.as_of),expected);
  assert.equal(data.weekly.at(-1).payload.metrics[0].actual,50);
  assert.equal(data.weekly.at(-1).payload.metrics[0].actual-data.weekly.at(-2).payload.metrics[0].actual,12);
  assert.ok(!data.reports.some(r=>r.month==='2026-10-01'));
 }
 assert.ok(baseline.weekly[0].payload.metrics.every(m=>m.actual===null));
 assert.throws(()=>imPresentation(profile,settings,'2026-02-30'));
});
test('isolated presentation contains six PL details with coherent values and a separate own premium history',()=>{
 const d=imPresentation(profile,settings,'2026-10-30');assert.equal(d.premiumHistory.length,24);
 const row=d.reports.at(-1),project=row.payload.qualitative.find(m=>m.key==='project');
 assert.equal(project.achievement,93);assert.equal(project.details.length,6);assert.equal(project.details.reduce((n,item)=>n+item.achievement,0)/6,93);
 assert.ok(project.details.every(item=>item.achievement>=0&&item.achievement<=100));
 assert.deepEqual(d.premiumHistory.at(-1),{month:'2026-09',premium:row.payload.premium,extrasAvailable:true,extras:row.payload.extras});
});
