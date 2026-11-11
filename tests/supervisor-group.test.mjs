import test from 'node:test';import assert from 'node:assert/strict';
import {supervisorGroup} from '../src/supervisorGroup.ts';
import {PROJECT_ASSESSMENT_ITEMS} from '../shared/projectAssessment.ts';
const metric=(achievement,change={})=>({key:'units',label:'Units',unit:'Stück',weight:100,resultState:'value',achievement,actual:null,target:null,...change});
const row=(person,month='2026-09',change={})=>({id:person+'-'+month,person_id:person,assignment_id:person+'-market',department_id:'IM',month:month+'-01',revision:1,published_at:'2026-10-01T08:00:00Z',payload:{setting:'full',sellout:100,softbonus:100,points:3,premium:100,extrasAvailable:true,extras:[],metrics:[metric(100)],qualitative:[]},...change});
const source=(members,reports,change={})=>({members:members.map(person_id=>({person_id,setting:'full'})),reports,premiumRows:reports,weekly:[],pointHistory:[],...change});

test('group means count each SEC once, use active corrections and preserve zero versus missing',()=>{
 const a=row('a'),b=row('b'),c=row('c');a.payload.sellout=0;b.payload.sellout=80;c.payload.sellout=null;
 b.payload.premium=200;c.payload.premium=null;b.payload.extras=[{type:'Extra',amount:10}];c.payload.extrasAvailable=false;
 const old={...a,revision:0,payload:{...a.payload,sellout:20}},duplicate={...a,id:'duplicate',assignment_id:'a-second-market'};
 const s=source(['a','b','c'],[a,b,c,old,duplicate,row('foreign'),row('a','2026-12')]);
 const d=supervisorGroup(s,'IM','2026-11-11'),m=d.months[0];
 assert.equal(d.members,3);assert.equal(d.months.length,1);assert.equal(m.reported,3);
 assert.deepEqual(m.sellout,{value:40,known:2,total:3});assert.deepEqual(m.premium,{value:150,known:2,total:3});assert.deepEqual(m.extras,{value:5,known:2,total:3});
});
test('conflicting market values remain unknown instead of double counting a person',()=>{
 const a=row('a'),a2=row('a'),b=row('b');a2.month='2026-09-01';a2.id='second';a2.assignment_id='a-second';
 a.payload.sellout=90;a2.payload.sellout=100;b.payload.sellout=80;
 a.payload.metrics=[metric(90)];a2.payload.metrics=[metric(100)];b.payload.metrics=[metric(80)];a2.payload.premium=200;
 const m=supervisorGroup(source(['a','b'],[a,a2,b]),'IM','2026-11-11').months[0];
 assert.deepEqual(m.sellout,{value:80,known:1,total:2});assert.deepEqual(m.metrics[0].achievement,{value:80,known:1,total:2});assert.deepEqual(m.premium,{value:100,known:1,total:2});
});
test('HA settings, units, LH blocks and criterion labels remain distinct',()=>{
 const a=row('a'),b=row('b');a.department_id=b.department_id='DA';b.payload.setting='vc';
 a.payload.metrics=[metric(90)];b.payload.metrics=[metric(110)];
 const d=supervisorGroup(source(['a','b'],[a,b],{members:[{person_id:'a',setting:'full'},{person_id:'b',setting:'vc'}]}),'DA','2026-11-11');
 assert.equal(d.months[0].metrics.length,2);for(const m of d.months[0].metrics)assert.equal(m.achievement.total,1);
 b.payload.setting='full';b.payload.metrics=[metric(110,{unit:'€'})];
 assert.equal(supervisorGroup(source(['a','b'],[a,b]),'DA','2026-11-11').months[0].metrics.length,2);
 a.department_id=b.department_id='LH';a.payload.metrics=[metric(90,{block:'HE'})];b.payload.metrics=[metric(110,{block:'IM'})];
 assert.equal(supervisorGroup(source(['a','b'],[a,b]),'LH','2026-11-11').months[0].metrics.length,2);
});
test('project assessment details retain their own averages without recomputing the parent',()=>{
 const a=row('a'),b=row('b');const child=PROJECT_ASSESSMENT_ITEMS[0][0];
 a.payload.qualitative=[metric(93,{key:'softbonus.pl-bewertung',label:'PL',unit:'%'}),metric(100,{key:child,label:'Reporting',unit:'%'})];
 b.payload.qualitative=[metric(97,{key:'softbonus.pl-bewertung',label:'PL',unit:'%'}),metric(80,{key:child,label:'Reporting',unit:'%'})];
 const m=supervisorGroup(source(['a','b'],[a,b]),'IM','2026-11-11').months[0].qualitative[0];assert.equal(m.achievement.value,95);assert.equal(m.details[0].achievement.value,90);
});
test('rolling values require twelve known months; source levels remain available for partial histories',()=>{
 const reports=Array.from({length:12},(_,i)=>row('a',i<3?'2025-'+String(10+i):'2026-'+String(i-2).padStart(2,'0')));
 reports.push(row('b'));const points=reports.map(r=>({month:r.month.slice(0,7),points:3,sourceLevel:'SEC+'}));
 const d=supervisorGroup(source(['a','b'],reports,{pointHistory:[{person_id:'a',history:points.filter((_,i)=>i<12)},{person_id:'b',history:[{month:'2026-09',points:3,sourceLevel:'SEC+'}]}]}),'IM','2026-11-11');
 const r=d.months.at(-1).rolling;assert.equal(r.fromMonth,'2025-10');assert.deepEqual(r.points,{value:36,known:1,total:2});assert.deepEqual(r.premium,{value:1200,known:1,total:2});assert.deepEqual(r.levels,{SEC:0,'SEC+':1,'SEC Pro':1,unknown:0});
});
test('weekly means use dated cumulative stands and changes use comparable people only',()=>{
 const weekly=[];
 for(const [person,day,actual,revision] of [['a','08',2,1],['a','08',3,2],['b','08',5,1],['a','15',8,1],['b','15',null,1],['a','30',100,1]]){
  const r=row(person,'2026-11');r.as_of='2026-11-'+day;r.published_at=r.as_of+'T08:00:00Z';r.revision=revision;r.payload.metrics=[metric(null,{actual,target:10})];weekly.push(r);
 }
 weekly.push({...row('a','2026-10'),as_of:'2026-10-29'});
 const d=supervisorGroup(source(['a','b'],[],{weekly}),'IM','2026-11-20');assert.equal(d.weekly.stands.length,2);
 const m=d.weekly.stands[1].metrics[0];assert.deepEqual(m.actual,{value:8,known:1,total:2});assert.deepEqual(m.change,{value:5,known:1,total:2});assert.equal(m.achievement.value,80);
});
test('invalid and not-applicable metrics do not become zero; an empty group has no fake data',()=>{
 const a=row('a'),b=row('b'),c=row('c');a.payload.metrics=[metric(0)];b.payload.metrics=[metric(100,{resultState:'invalid'})];c.payload.metrics=[metric(100,{resultState:'not-applicable'})];
 const m=supervisorGroup(source(['a','b','c'],[a,b,c]),'IM','2026-11-11').months[0].metrics[0];assert.deepEqual(m.achievement,{value:0,known:1,total:2});
 assert.deepEqual(supervisorGroup(source([],[]),'IM','2026-11-11'),{groupId:'IM',calendarDay:'2026-11-11',members:0,months:[],weekly:{month:'2026-11',stands:[]}});
 const st=row('a');st.department_id='ST';const d=supervisorGroup(source(['a'],[st]),'ST','2026-11-11');assert.equal(d.months[0].metrics.length,0);assert.equal(d.months[0].rolling.points.value,null);
});
