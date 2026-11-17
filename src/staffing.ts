import {marketKey,marketSimilarity,matchRosterMarket,rosterForMonth,type RosterEntry} from './roster.ts';
import type {ImportContext} from './imports.ts';

export type SourceDivision='HE'|'IM';
export type StaffingPlan={version:1;market:string;source:SourceDivision;expected:Partial<Record<SourceDivision,number>>};
export type StaffingEvidence={importId:string;source:SourceDivision;asOf:string;savedAt:string;status:'draft'|'published';personId:string;plan:StaffingPlan;legacy?:boolean};
export type StaffingSource={division:SourceDivision;expectedPeople:number;receivedPeople:number;status:'awaiting'|'draft'|'published'|'restricted';asOf:string|null};
export type StaffingProgress={market:string;sources:StaffingSource[];complete:boolean};
const address=(value:string)=>marketKey(value).split(' ').sort().join(' ');
const validExpected=(value:unknown):value is StaffingPlan['expected']=>Boolean(value&&typeof value==='object'&&!Array.isArray(value)&&Object.entries(value).length===2&&Object.entries(value).every(([key,n])=>['HE','IM'].includes(key)&&Number.isInteger(n)&&Number(n)>0&&Number(n)<=10));
export function readStaffingPlan(value:unknown):StaffingPlan|null{
 if(!value||typeof value!=='object')return null;
 const p=value as StaffingPlan;
 return p.version===1&&typeof p.market==='string'&&p.market.length<=500&&address(p.market)&&['HE','IM'].includes(p.source)&&validExpected(p.expected)?p:null;
}
export function matchingStaffing(market:string,evidence:StaffingEvidence[],asOf:string){
 const scored=evidence.filter(e=>e.asOf<=asOf).map(e=>({e,score:marketSimilarity(market,e.plan.market)})).sort((a,b)=>b.score-a.score);
 const best=scored[0]?.score??0;if(best<.84)return[];
 const top=scored.filter(s=>s.score===best),runner=scored.find(s=>s.score<best);
 if(new Set(top.map(s=>address(s.e.plan.market))).size!==1||best<1&&runner&&best-runner.score<.10)return[];
 return top.map(s=>s.e);
}

/** HOURS counts physical staff, not people to request from every division file. */
export function planMarketStaffing(market:string,ctx:ImportContext,count:number|null,lighthouse:boolean,reference:RosterEntry[],previous:StaffingEvidence[]):StaffingPlan|null{
 if(ctx.phase==='MONTH_FINALIZATION'||!['HE','IM'].includes(ctx.group))return null;
 const source=ctx.group as SourceDivision;
 const found=Object.fromEntries(['HE','IM','LH'].map(g=>[g,matchRosterMarket(market,rosterForMonth(reference,g,ctx.month))]));
 const he=found.HE,im=found.IM,lh=found.LH;
 const n=(g:'HE'|'IM'|'LH')=>new Set(found[g].entries.map(e=>e.person_id??e.id)).size;
 if(!he.ambiguous&&!im.ambiguous&&!lh.ambiguous){
  const h=n('HE'),i=n('IM'),l=n('LH');
  // Same-division double staffing remains a same-division source row.
  if((lighthouse||Boolean(count&&count>1&&h+i+l===count))&&(h+l)>0&&(i+l)>0){
   return{version:1,market:found[source].entries[0]?.market??lh.entries[0]?.market??market,source,expected:{HE:h+l,IM:i+l}};
  }
  // An explicit Lighthouse type can leave the other division unassigned until its file arrives.
  if(lighthouse&&l===0&&n(source)===1&&n(source==='HE'?'IM':'HE')===0){
   return{version:1,market:found[source].entries[0].market,source,expected:{HE:1,IM:1}};
  }
 }
 const remembered=matchingStaffing(market,previous,ctx.asOf).filter(e=>!e.legacy).sort((a,b)=>b.asOf.localeCompare(a.asOf)||b.savedAt.localeCompare(a.savedAt))[0]?.plan;
 // A remembered opposite-side import supplies the missing slot type, never somebody's KPI values.
 if(remembered&&(!count||count>1)&&!found[source].ambiguous&&n(source)<=Number(remembered.expected[source]))return{...remembered,source};
 return null;
}

export function staffingProgress(plan:StaffingPlan,evidence:StaffingEvidence[],asOf:string,permitted:readonly string[]=['HE','IM']):StaffingProgress{
 const matching=matchingStaffing(plan.market,evidence,asOf);
 const sources=(['HE','IM'] as const).map(division=>{
  if(!permitted.includes(division))return{division,expectedPeople:plan.expected[division]??0,receivedPeople:0,status:'restricted' as const,asOf:null};
  const candidates=matching.filter(e=>e.source===division).sort((a,b)=>b.asOf.localeCompare(a.asOf)||b.savedAt.localeCompare(a.savedAt));
  const latest=candidates[0];
  const recipients=new Set(candidates.filter(e=>e.importId===latest?.importId).map(e=>e.personId));
  return{division,expectedPeople:plan.expected[division]??0,receivedPeople:recipients.size,status:latest?.status??'awaiting' as const,asOf:latest?.asOf??null};
 });
 return{market:plan.market,sources,complete:sources.every(s=>s.status!=='restricted'&&s.receivedPeople>=s.expectedPeople)};
}

export function staffingOverview(evidence:StaffingEvidence[],asOf:string,permitted:readonly string[]){
 const latest=new Map<string,StaffingEvidence>();
 for(const e of evidence.filter(e=>!e.legacy&&e.asOf<=asOf).sort((a,b)=>a.asOf.localeCompare(b.asOf)||a.savedAt.localeCompare(b.savedAt)))latest.set(address(e.plan.market),e);
 return [...latest.values()].map(e=>staffingProgress(e.plan,evidence,asOf,permitted));
}
