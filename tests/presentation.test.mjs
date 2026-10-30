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
test('publication window and cumulative weekly updates follow the actual calendar, including year rollover',()=>{
 assert.equal(imPresentation(profile,settings,'2026-11-14').reports.at(-1).month,'2026-09-01');
 assert.equal(imPresentation(profile,settings,'2026-11-15').reports.at(-1).month,'2026-10-01');
 assert.equal(imPresentation(profile,settings,'2027-01-03').reports.at(-1).month,'2026-11-01');
 const d=imPresentation(profile,settings,'2026-10-30');assert.deepEqual(d.weekly.map(w=>w.as_of),['2026-10-01','2026-10-08','2026-10-15','2026-10-22','2026-10-29']);
 assert.ok(d.weekly[0].payload.metrics.every(m=>m.actual===null));
 const units=d.weekly.slice(1).map(w=>w.payload.metrics[0].actual);assert.ok(units.every((v,i)=>i===0||v>units[i-1]));
 assert.ok(imPresentation(profile,settings,'2026-10-14').weekly.every(w=>w.as_of<='2026-10-14'));
 assert.deepEqual(imPresentation(profile,settings,'2026-11-01').weekly.map(w=>w.as_of),['2026-11-01']);
 assert.ok(imPresentation(profile,settings,'2027-02-28').weekly.every(w=>w.as_of<='2027-02-28'));
 assert.throws(()=>imPresentation(profile,settings,'2026-02-30'));
});
