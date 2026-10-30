import { IM_METRICS, qualitativeMetrics, performanceTier } from '../shared/groups.ts';
import { presentationProjectDetails } from '../shared/projectAssessment.ts';
import { ownPremiumHistory } from './premiumHistory.ts';
import { presentationAssessmentLabel } from '../shared/presentationAssessments.ts';

export type PresentationSettings={personId:string;assignmentId:string;market:string;readIds:string[]};
type PresentationProfile={user_id:string;person_id:string|null;is_test:boolean;role:string;primary_department:string|null};
const round=(n:number)=>Math.round(n*10)/10;
const monthAt=(month:string,offset:number)=>new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5,7))-1+offset,1)).toISOString().slice(0,7);
const pointsPattern=[1,2,1,1,2,2,1,2,2,2,2,2,2,2,3,2,3,3,3,2,3,3,3,3];
const weighted=(metrics:{achievement:number;weight:number|null}[])=>round(metrics.reduce((sum,m)=>sum+m.achievement*(m.weight??0)/100,0));

/** Entirely synthetic presentation model. Never reads employee records or calculates real payroll. */
export function imPresentation<T extends PresentationProfile>(profile:T,settings:PresentationSettings,day:string,requestedAssignment?:string|null){
 if(!profile.is_test||profile.role!=='sec'||profile.primary_department!=='IM'||profile.person_id!==null)throw new Error('Isolated IM presentation account required');
 if(requestedAssignment&&requestedAssignment!==settings.assignmentId)throw new RangeError('Own presentation assignment required');
 if(!/^\d{4}-\d{2}-\d{2}$/.test(day)||new Date(day+'T12:00:00Z').toISOString().slice(0,10)!==day)throw new RangeError('Valid calendar day required');
 const through=monthAt(day.slice(0,7),Number(day.slice(8))>=15?-1:-2);
 const months=Array.from({length:24},(_,index)=>monthAt(through,index-23));
 const assignment={id:settings.assignmentId,person_id:settings.personId,department_id:'IM',setting:'full',market:settings.market,active:true};
 const reports=months.map(month=>{
  const index=((Number(month.slice(0,4))*12+Number(month.slice(5))-1)%24+24)%24;
  const points=pointsPattern[index],base=points===3?102:points===2?93:86;
  const targets=[44+index%4*2,70+index%3*5,1090+index%5*10,40+index%3*2,22+index%4,120+index%3*5];
  const offsets=[-2,5,3,-8,1,4];
  const metrics=IM_METRICS.map((metric,i)=>{
   const target=targets[i],actual=Math.round(target*(base+offsets[i])/100);
   return{...metric,resultState:'value' as const,target,actual,achievement:round(actual/target*100)};
  });
  const qualitative=qualitativeMetrics('IM').map((metric,i)=>{
   const achievement=points===3?[98,100,97][i]:points===2?[93,94,92][i]:[86,85,88][i];
   return{...metric,label:metric.key==='knowledge'?presentationAssessmentLabel(month,metric.label):metric.label,resultState:'value' as const,target:100,actual:achievement,achievement,...(metric.key==='project'?{details:presentationProjectDetails(achievement)}:{})};
  });
  const sellout=weighted(metrics),softbonus=weighted(qualitative);
  const id='presentation-'+settings.assignmentId+'-'+month;
  return{id,person_id:settings.personId,assignment_id:settings.assignmentId,department_id:'IM',month:month+'-01',revision:1,
   import_id:'presentation-only',configuration_id:null,published_at:monthAt(month,1)+'-15T08:00:00Z',
   payload:{groupId:'IM',setting:'full',month,sourceLevel:null,configurationVersion:'presentation-im-v1',sellout,softbonus,
    tier:performanceTier('IM',sellout,softbonus),points,premium:round((points===3?1360:points===2?990:650)+index%4*37.5),
    extrasAvailable:true,extras:index%3===0?[{type:'On-top',amount:150+index%4*25}]:[],metrics,qualitative,changed:[]}};
 });
 const currentMonth=day.slice(0,7),targets=[50,80,1120,44,24,130],stages=[0,.23,.47,.72,.96];
 const weekly=[1,8,15,22,29].flatMap((date,index)=>{
  const asOf=currentMonth+'-'+String(date).padStart(2,'0');if(asOf>day)return[];
  return[{id:'presentation-weekly-'+settings.assignmentId+'-'+asOf,person_id:settings.personId,assignment_id:settings.assignmentId,
   department_id:'IM',month:currentMonth+'-01',as_of:asOf,revision:1,published_at:asOf+'T08:00:00Z',
   payload:{setting:'full',metrics:IM_METRICS.map((metric,i)=>({ ...metric,target:targets[i],
    actual:index===0?null:metric.unit==='€'?[null,1087,1101,1098,1117][index]:Math.round(targets[i]*stages[index]*[1.05,1.02,1,.88,.94,1.04][i])}))}}];
 });
 return{presentation:true,profile:{...profile,person_id:settings.personId},assignments:[assignment],selectedAssignment:assignment.id,
  reports,weekly,read:settings.readIds.filter(id=>reports.some(r=>r.id===id)).map(report_id=>({report_id})),
  premiumHistory:ownPremiumHistory(reports,settings.personId,'IM'),
  pointHistory:reports.map(r=>({month:r.month.slice(0,7),points:r.payload.points,sourceLevel:null})),
  rankings:Object.fromEntries(months.map((month,index)=>[month,index<11
   ?{pool:28,rank:null,outsideTopTen:false,reason:'incomplete-history'}
   :{pool:28,rank:3,outsideTopTen:false}])),
  calendarDay:day,realCalendarDay:day,testReplay:false};
}
