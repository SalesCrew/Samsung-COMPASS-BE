import type { NormalizedRow } from './imports.ts';

export type ImportPerson={id:string;external_id:string;name:string};
export type ImportAssignment={person_id:string;department_id:string;setting:string;market:string};
export type IdentityMatch={row:number;sourceName:string;sourceExternalId:string;sourceMarket:string;personId:string|null;status:'matched'|'unresolved'|'new';method:'id'|'name'|'fuzzy'|'market'|'manual'|'new'|null;score:number|null;message:string};

/** Token sorting makes case, accents, separators and surname order irrelevant. */
export function nameKey(value:string){return value.normalize('NFKD').replace(/\p{M}/gu,'').toLocaleLowerCase('de-AT').replace(/ß/g,'ss').split(/[^\p{L}\p{N}]+/u).filter(Boolean).sort().join(' ');}
function similarity(a:string,b:string){
 if(a===b)return 1;if(!a||!b)return 0;
 let previous=Array.from({length:b.length+1},(_,i)=>i);
 for(let i=1;i<=a.length;i++){const next=[i];for(let j=1;j<=b.length;j++)next[j]=Math.min(next[j-1]+1,previous[j]+1,previous[j-1]+(a[i-1]===b[j-1]?0:1));previous=next;}
 return 1-previous[b.length]/Math.max(a.length,b.length);
}
export function resolveImportPeople(rows:NormalizedRow[],people:ImportPerson[],assignments:ImportAssignment[],group:string,setting:string,choices:Record<string,string>={}){
 const byId=new Map(people.map(p=>[p.id,p])),byExternal=new Map(people.map(p=>[p.external_id,p]));
 const groupAssignments=assignments.filter(a=>a.department_id===group&&a.setting===setting);
 const assigned=new Set(groupAssignments.map(a=>a.person_id));
 const nameCandidates=people.filter(p=>assigned.has(p.id)||!assignments.some(a=>a.person_id===p.id));
 const names=nameCandidates.map(person=>({person,key:nameKey(person.name)}));
 const issues:{row:number;column:string;message:string}[]=[],matches:IdentityMatch[]=[],records:NormalizedRow[]=[];
 const seen=new Set<string>();
 for(const row of rows){
  const match:IdentityMatch={row:row.row,sourceName:row.name,sourceExternalId:row.externalId,sourceMarket:row.market,personId:null,status:'unresolved',method:null,score:null,message:''};
  const selected=choices[String(row.row)];const exactId=byExternal.get(row.externalId);let person:ImportPerson|undefined;
  if(selected==='new'){
   if(exactId&&nameKey(exactId.name)===nameKey(row.name)){person=exactId;match.method='id';match.score=1;}
   else if(exactId){match.message='Diese SEC-ID gehört bereits zu einer vorhandenen Person.';}
   else if(!row.externalId||!row.name||!row.market){match.message='Für eine neue Person werden SEC-ID, Name und Markt aus der Datei benötigt.';}
   else{match.status='new';match.method='new';}
  }else if(selected){person=byId.get(selected);match.method='manual';if(!person)match.message='Die gewählte Person ist nicht mehr verfügbar.';else if(exactId&&exactId.id!==person.id){person=undefined;match.message='SEC-ID und gewählte Person widersprechen sich. Bitte die Datei prüfen.';}}
  else if(exactId){
   const sourceKey=nameKey(row.name),storedKey=nameKey(exactId.name);
   const score=sourceKey&&storedKey?similarity(sourceKey,storedKey):1;
   if(score>=.9){person=exactId;match.method=score===1?'id':'fuzzy';match.score=Math.round(score*1000)/1000;}
   else match.message='SEC-ID und Name passen nicht eindeutig zusammen. Bitte die Person bestätigen.';
  }
  else if(row.name){
   const key=nameKey(row.name);const exact=names.filter(n=>n.key&&n.key===key);
   if(exact.length===1){person=exact[0].person;match.method='name';match.score=1;}
   else if(exact.length>1)match.message='Mehrere Personen haben diesen Namen. Bitte auswählen.';
   else if(key.length>=8&&key.includes(' ')){
    const scored=names.map(n=>({...n,score:similarity(key,n.key)})).sort((a,b)=>b.score-a.score);
    if(scored[0]?.score>=.9&&scored[0].score-(scored[1]?.score??0)>=.08){person=scored[0].person;match.method='fuzzy';match.score=Math.round(scored[0].score*1000)/1000;}
   }
  }else if(row.market){
   const ids=new Set(groupAssignments.filter(a=>nameKey(a.market)===nameKey(row.market)).map(a=>a.person_id));
   if(ids.size===1){person=byId.get([...ids][0]);match.method='market';match.score=1;}
   else if(ids.size>1)match.message='Der Markt hat mehrere Personen. Bitte die richtige Person auswählen.';
  }
  let market=row.market;
  if(person&&!market){const markets=[...new Set(groupAssignments.filter(a=>a.person_id===person!.id).map(a=>a.market))];if(markets.length===1)market=markets[0];else{person=undefined;match.message='Der Markt ist nicht eindeutig. Bitte die Marktspalte zuordnen.';}}
  if(person&&market){match.personId=person.id;match.status='matched';}
  if(match.status==='unresolved'){match.message||='Keine eindeutige Person gefunden. Bitte im Dropdown zuordnen.';issues.push({row:row.row,column:'',message:match.message});matches.push(match);continue;}
  const resolved={...row,externalId:person?.external_id??row.externalId,name:person?.name.trim()?person.name:row.name,market,normalized:{...row.normalized,identity:{personId:person?.id??null,sourceName:row.name,sourceExternalId:row.externalId,method:match.method}}};
  const key=resolved.externalId+'|'+market;
  if(seen.has(key))issues.push({row:row.row,column:'',message:'Mehrere Zeilen wurden derselben Person und demselben Markt zugeordnet.'});
  seen.add(key);records.push(resolved);matches.push(match);
 }
 return{records,matches,issues,unresolvedCount:matches.filter(m=>m.status==='unresolved').length};
}
