import type { ServerSheet } from './workbook.ts';

export type RosterRow={source_row:number;email:string;department_id:string;first_name:string;last_name:string;market:string};
export type RosterEntry={id:string;person_id:string|null;department_id:string;market:string;source_month:string;source_hash:string;imported_at:string;email?:string};
const headerKey=(value:unknown)=>String(value??'').normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase().replace(/[^a-z0-9]/g,'');
const fields={nachname:'last_name',vorname:'first_name',division:'department_id',email:'email',emailadresse:'email',markt:'market'} as const;

/** Returns only the five necessary fields. Supervisor/other cells never leave the workbook parser. */
export function parseRoster(sheets:ServerSheet[]){
 for(const sheet of sheets){
  const header=sheet.allRows.slice(0,15).find(row=>new Set(Object.values(row.cells).map(c=>fields[headerKey(c.value) as keyof typeof fields]).filter(Boolean)).size===5);
  if(!header)continue;
  const columns=Object.entries(header.cells).flatMap(([column,cell])=>{const field=fields[headerKey(cell.value) as keyof typeof fields];return field?[{column,field,label:String(cell.value).trim()}]:[];});
  if(new Set(columns.map(c=>c.field)).size!==columns.length)throw new Error('Eine benötigte Spaltenüberschrift kommt mehrfach vor.');
  const records:RosterRow[]=[],issues:{row:number;field:string;message:string}[]=[];
  for(const row of sheet.allRows.filter(r=>r.row>header.row)){
   const values=Object.fromEntries(columns.map(c=>[c.field,row.cells[c.column]]));
   if(Object.values(values).every(c=>!c||c.kind==='blank'||c.value===''))continue;
   const record=Object.fromEntries(columns.map(c=>[c.field,values[c.field]?.kind==='value'?String(values[c.field]?.value??'').trim():''])) as Omit<RosterRow,'source_row'>;
   record.email=record.email.toLowerCase();
   record.department_id=record.department_id.toUpperCase().replace(/^HA(?:\/DA)?$/,'DA');
   for(const c of columns)if(!record[c.field]||values[c.field]?.kind!=='value')issues.push({row:row.row,field:c.label,message:'Pflichtwert fehlt oder die Excel-Zelle ist nicht lesbar.'});
   if(record.email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(record.email))issues.push({row:row.row,field:'Email',message:'Bitte eine gültige E-Mail-Adresse eintragen.'});
   if(record.department_id&&!['HE','DA','IM','LH','ST'].includes(record.department_id))issues.push({row:row.row,field:'Division',message:'Zulässig sind HA/DA, HE, IM, LH und ST.'});
   records.push({...record,source_row:row.row});
  }
  if(records.length>5000)throw new Error('Die Referenzliste darf höchstens 5.000 Einträge enthalten.');
  return{records,issues,headers:columns.map(c=>c.label)};
 }
 throw new Error('Die Liste benötigt die Überschriften Nachname, Vorname, Division, Email und Markt.');
}

/** Stable spelling normalization, without removing house numbers or floor/suffix information. */
export function marketKey(value:string){
 return value.normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase().replace(/ß/g,'ss')
  .replace(/\bmedia[\s-]*markt\b/g,' ').replace(/\bmm\b/g,' ')
  .replace(/stra(?:ss|ß)e\b|\bstr\.?(?=\s|$)/g,'strasse')
  .replace(/\bst[.]?(?=\s)/g,'sankt').replace(/\b(\d+)\s+([a-z])\b/g,'$1$2')
  .replace(/[^\p{L}\p{N}]+/gu,' ').trim().replace(/\s+/g,' ');
}
function editSimilarity(a:string,b:string){
 if(a===b)return 1;if(!a||!b)return 0;
 let prev=Array.from({length:b.length+1},(_,i)=>i);
 for(let i=1;i<=a.length;i++){const next=[i];for(let j=1;j<=b.length;j++)next[j]=Math.min(next[j-1]+1,prev[j]+1,prev[j-1]+(a[i-1]===b[j-1]?0:1));prev=next;}
 return 1-prev[b.length]/Math.max(a.length,b.length);
}
export function marketSimilarity(left:string,right:string){
 const a=marketKey(left),b=marketKey(right);
 if(!a||!b)return 0;if(a===b)return 1;
 // Do not collapse different branches, house numbers, floors or unit suffixes.
 const numbers=(s:string)=>s.match(/\d+[a-z]?/g)??[];
 const an=numbers(a),bn=numbers(b);
 if(an.length&&bn.length&&(an.length!==bn.length||[...an].sort().join('|')!==[...bn].sort().join('|')))return 0;
 const sorted=(s:string)=>s.split(' ').sort().join(' ');
 if(sorted(a)===sorted(b))return 1;
 const at=a.split(' '),bt=b.split(' ');
 // A roster may abbreviate a market while the assignment includes district/address details.
 // Distinct supplied branch/house numbers were rejected above; one-word locations stay exact-only.
 if(Math.min(at.length,bt.length)>=2&&(at.every(t=>bt.includes(t))||bt.every(t=>at.includes(t))))return .92;
 return Math.max(editSimilarity(a,b),editSimilarity(sorted(a),sorted(b)));
}

/** Latest source snapshot at/before this report month; current staff must not rewrite older ownership. */
export function rosterForMonth(entries:RosterEntry[],group:string,month:string){
 const eligible=entries.filter(r=>r.department_id===group&&r.source_month<=month);
 const sourceMonth=eligible.map(r=>r.source_month).sort().at(-1);
 const current=eligible.filter(r=>r.source_month===sourceMonth);
 const latest=current.map(r=>r.imported_at).sort().at(-1);
 return current.filter(r=>r.imported_at===latest);
}
export function matchRosterMarket(market:string,entries:RosterEntry[]){
 const scored=entries.map(entry=>({entry,score:marketSimilarity(market,entry.market)})).sort((a,b)=>b.score-a.score);
 const best=scored[0]?.score??0;
 if(best<.84||marketKey(market).length<(best===1?3:5))return{entries:[],score:best,ambiguous:false};
 const top=scored.filter(r=>r.score===best);
 if(best<1&&new Set(top.map(r=>marketKey(r.entry.market).split(' ').sort().join(' '))).size>1)return{entries:[],score:best,ambiguous:true};
 const runner=scored.find(r=>r.score<best);
 if(best<1&&runner&&best-runner.score<.10)return{entries:[],score:best,ambiguous:true};
 // Multiple people at the same physical market are deliberately retained as a conflict.
 return{entries:top.map(r=>r.entry),score:Math.round(best*1000)/1000,ambiguous:false};
}
