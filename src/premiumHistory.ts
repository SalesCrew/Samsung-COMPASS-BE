type Report={id:string;person_id:string;department_id:string;assignment_id:string;month:string;revision:number;payload:{premium?:unknown;extras?:{type:string;amount:number}[];extrasAvailable?:boolean}};
const finite=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value);
/** Own division only. Agreeing duplicate assignments count once; ambiguous source amounts stay unknown. */
export function ownPremiumHistory(reports:readonly Report[],personId:string,department:string){
 const latest=new Map<string,Report>();
 for(const row of reports){
  if(row.person_id!==personId||row.department_id!==department)continue;
  const key=row.assignment_id+'|'+row.month,previous=latest.get(key);
  if(!previous||row.revision>previous.revision)latest.set(key,row);
 }
 const months=Map.groupBy([...latest.values()],r=>r.month.slice(0,7));
 return [...months].sort(([a],[b])=>a.localeCompare(b)).map(([month,rows])=>{
  const values=rows.map(r=>r.payload.premium);
  const premium=values.every(finite)&&new Set(values).size===1?values[0] as number:null;
  const amounts=rows.map(r=>{
   const extras=r.payload.extras;
   if(!Array.isArray(extras)||extras.some(e=>typeof e.type!=='string'||!finite(e.amount)))return null;
   if(r.payload.extrasAvailable===false||r.payload.extrasAvailable===undefined&&!extras.length&&!['LH','ST'].includes(department))return null;
   return [...extras].sort((a,b)=>a.type.localeCompare(b.type)||a.amount-b.amount);
  });
  const extrasAvailable=amounts.every(a=>a!==null)&&new Set(amounts.map(a=>JSON.stringify(a))).size===1;
  return {month,premium,extrasAvailable,extras:extrasAvailable?amounts[0]!:[]};
 });
}
