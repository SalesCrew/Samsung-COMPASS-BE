import {groupProjectAssessment} from '../shared/projectAssessment.ts';
import {annualCategory} from '../shared/annual.ts';
import {ownPremiumHistory} from './premiumHistory.ts';
import type {GroupAverageMetric,GroupMean,SupervisorGroupData} from '../shared/supervisorGroup.ts';

type Metric={key:string;label:string;unit:string;block?:string;weight:number|null;resultState?:string;achievement?:number|null;actual:number|null;target:number|null;details?:Metric[]};
type Row={id:string;person_id:string;assignment_id:string;department_id:string;month:string;revision:number;published_at:string;as_of?:string;payload:{setting:string;sellout?:number|null;softbonus?:number|null;points?:number|null;premium?:number|null;extras?:{type:string;amount:number}[];extrasAvailable?:boolean;metrics?:Metric[];qualitative?:Metric[]}};
export type GroupSource={members:{person_id:string;setting:string}[];reports:Row[];weekly:Row[];premiumRows:Row[];pointHistory:{person_id:string;history:{month:string;points:number|null;sourceLevel?:string|null}[]}[]};
const finite=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v);
const agreed=(values:unknown[])=>values.length&&values.every(finite)&&values.every(v=>v===values[0])?values[0] as number:null;
const mean=(values:(number|null)[],total:number):GroupMean=>{const known=values.filter(finite);return{value:known.length?known.reduce((n,v)=>n+v,0)/known.length:null,known:known.length,total};};
const priorMonth=(month:string)=>{const d=new Date(month+'-01T12:00:00Z');d.setUTCMonth(d.getUTCMonth()-1);return d.toISOString().slice(0,7);};
const metricId=(m:Metric,setting:string)=>JSON.stringify([setting,m.key,m.unit,m.label,m.block??'']);
function latest(rows:Row[],weekly=false){
 const active=new Map<string,Row>();
 for(const row of rows){const key=row.assignment_id+'|'+row.month+(weekly?'|'+row.as_of:'');const old=active.get(key);if(!old||row.revision>old.revision)active.set(key,row);}
 return [...active.values()];
}
function metricGroups(rows:Row[],members:GroupSource['members'],kind:'metrics'|'qualitative',weekly=false){
 const definitions=new Map<string,{metric:Metric;setting:string}>();
 const byPerson=new Map<string,Map<string,Metric[]>>();
 for(const row of rows){
  const setting=row.payload.setting??'full';
  const metrics=kind==='qualitative'?groupProjectAssessment((row.payload.qualitative??[]) as Parameters<typeof groupProjectAssessment>[0]) as Metric[]:row.payload.metrics??[];
  for(const original of metrics){
   const metric=weekly?{...original,actual:finite(original.actual)&&original.actual>=0?original.actual:null,target:finite(original.target)&&original.target>0?original.target:null,achievement:finite(original.actual)&&original.actual>=0&&finite(original.target)&&original.target>0?original.actual/original.target*100:null}:original;
   const id=metricId(metric,setting);definitions.set(id,{metric,setting});
   if(!byPerson.has(id))byPerson.set(id,new Map());const people=byPerson.get(id)!;
   people.set(row.person_id,[...(people.get(row.person_id)??[]),metric]);
  }
 }
 return [...definitions].map(([id,{metric,setting}])=>{
  const people=byPerson.get(id)!;
  const eligible=members.filter(p=>p.setting===setting&&!(people.get(p.person_id)?.every(m=>m.resultState==='not-applicable')));
  const value=(person:string,key:'achievement'|'actual'|'target')=>{
   const values=people.get(person);return values?.length?agreed(values.map(m=>m.resultState==='missing'||m.resultState==='invalid'||m.resultState==='not-applicable'?null:m[key])):null;
  };
  const weights=[...people.values()].flat().map(m=>m.weight);
  const item:GroupAverageMetric={id,label:metric.label,unit:metric.unit,block:metric.block??'',setting,
   achievement:mean(eligible.map(p=>value(p.person_id,'achievement')),eligible.length),actual:mean(eligible.map(p=>value(p.person_id,'actual')),eligible.length),target:mean(eligible.map(p=>value(p.person_id,'target')),eligible.length),weight:agreed(weights)};
  const detailRows=rows.map(row=>({...row,payload:{...row.payload,metrics:(people.get(row.person_id)??[]).length?(kind==='qualitative'?groupProjectAssessment((row.payload.qualitative??[]) as Parameters<typeof groupProjectAssessment>[0]) as Metric[]:row.payload.metrics??[]).filter(m=>metricId(m,row.payload.setting??'full')===id).flatMap(m=>m.details??[]).map(child=>({...child,unit:'%',actual:null,target:null,weight:null})):[]}}));
  if([...people.values()].flat().some(m=>m.details?.length))item.details=metricGroups(detailRows,members,'metrics');
  return item;
 });
}

/** One SEC is one vote. Agreeing duplicate markets count once; ambiguity stays unknown. */
export function supervisorGroup(source:GroupSource,groupId:SupervisorGroupData['groupId'],calendarDay:string):SupervisorGroupData{
 const members=[...new Map(source.members.map(p=>[p.person_id,p])).values()];
 const ids=new Set(members.map(p=>p.person_id));
 const eligible=(rows:Row[])=>rows.filter(r=>r.department_id===groupId&&ids.has(r.person_id)&&r.month.slice(0,7)<=calendarDay.slice(0,7));
 const reports=latest(eligible(source.reports));
 const premiums=new Map(members.map(p=>[p.person_id,ownPremiumHistory(source.premiumRows,p.person_id,groupId)]));
 const history=new Map(source.pointHistory.map(p=>[p.person_id,p.history]));
 const months=[...new Set(reports.map(r=>r.month.slice(0,7)))].sort().map(month=>{
  const rows=reports.filter(r=>r.month.slice(0,7)===month);
  const perPerson=Map.groupBy(rows,r=>r.person_id);
  const field=(key:'sellout'|'softbonus'|'points'|'premium')=>mean(members.map(p=>agreed((perPerson.get(p.person_id)??[]).map(r=>r.payload[key]))),members.length);
  const window=[month];while(window.length<12)window.unshift(priorMonth(window[0]));
  const sums=(key:'points'|'premium'|'extras')=>members.map(p=>{
   const values=window.map(m=>key==='points'?history.get(p.person_id)?.find(h=>h.month===m)?.points:(()=>{const r=premiums.get(p.person_id)?.find(h=>h.month===m);return key==='premium'?r?.premium:r?.extrasAvailable?r.extras.reduce((n,e)=>n+e.amount,0):null;})());
   return values.every(finite)?values.reduce((n,v)=>n+v,0):null;
  });
  const rollingPoints=groupId==='ST'?members.map(()=>null):sums('points');
  const levels={SEC:0,'SEC+':0,'SEC Pro':0,unknown:0};
  if(groupId!=='ST')for(const [i,p]of members.entries()){
   const source=history.get(p.person_id)?.find(h=>h.month===month)?.sourceLevel;
   const level=rollingPoints[i]!==null?annualCategory(rollingPoints[i]!):source==='SEC'||source==='SEC+'||source==='SEC Pro'?source:null;
   levels[level??'unknown']++;
  }
  const extraValues=members.map(p=>{const r=ownPremiumHistory(perPerson.get(p.person_id)??[],p.person_id,groupId)[0];return r?.extrasAvailable?r.extras.reduce((n,e)=>n+e.amount,0):null;});
  return {month,reported:perPerson.size,publishedAt:rows.map(r=>r.published_at).sort().at(-1)??null,
   sellout:field('sellout'),softbonus:field('softbonus'),points:field('points'),premium:field('premium'),extras:mean(extraValues,members.length),
   metrics:groupId==='ST'?[]:metricGroups(rows,members,'metrics'),qualitative:metricGroups(rows,members,'qualitative'),
   rolling:{fromMonth:window[0],points:mean(rollingPoints,members.length),premium:mean(sums('premium'),members.length),extras:mean(sums('extras'),members.length),levels}};
 });
 const weekly=latest(eligible(source.weekly).filter(r=>r.month.slice(0,7)===calendarDay.slice(0,7)&&r.as_of&&r.as_of<=calendarDay&&r.published_at.slice(0,10)<=calendarDay),true);
 const stands=[...new Set(weekly.map(r=>r.as_of!))].sort().map(asOf=>{
  const rows=weekly.filter(r=>r.as_of===asOf);
  return {asOf,updatedAt:rows.map(r=>r.published_at).sort().at(-1)!,metrics:metricGroups(rows,members,'metrics',true)};
 });
 // Weekly improvement uses only paired, comparable people on adjacent dated stands.
 for(let i=1;i<stands.length;i++)for(const metric of stands[i].metrics){
  const changes=members.filter(p=>p.setting===metric.setting).map(p=>{
   const own=(asOf:string)=>agreed(weekly.filter(r=>r.as_of===asOf&&r.person_id===p.person_id).map(r=>(()=>{const m=r.payload.metrics?.find(m=>metricId(m,r.payload.setting??'full')===metric.id);return m&&finite(m.actual)&&m.actual>=0&&!['missing','invalid','not-applicable'].includes(m.resultState??'')?m.actual:null;})()));
   const current=own(stands[i].asOf),previous=own(stands[i-1].asOf);return current!==null&&previous!==null?current-previous:null;
  });metric.change=mean(changes,changes.length);
 }
 return{groupId,calendarDay,members:members.length,months,weekly:{month:calendarDay.slice(0,7),stands}};
}
