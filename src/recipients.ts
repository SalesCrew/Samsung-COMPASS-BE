import { resolveImportPeople, nameKey, type ImportPerson, type ImportAssignment, type IdentityMatch } from './identity.ts';
import type { NormalizedRow, ImportContext } from './imports.ts';
import { rosterForMonth, matchRosterMarket, marketSimilarity, marketKey, type RosterEntry } from './roster.ts';
import {planMarketStaffing,staffingProgress,type StaffingEvidence,type StaffingProgress} from './staffing.ts';
import {importPersonIds} from './importPeople.ts';

export type PersonChoices=Record<string,string|string[]>;
export type StaffingHint={count:number|null;lighthouse:boolean};
export type Recipient={personId:string;name:string;departmentId:string;market:string};
export type RecipientMatch=IdentityMatch & {recipients?:Recipient[];expectedCount?:number;shared?:boolean;targetGroup?:string;targetGroups?:string[];staffing?:StaffingProgress & {currentDivision:'HE'|'IM'}};

/** One source market may serve several people. Personal closing values never fan out. */
export function resolveRecipients(rows:NormalizedRow[],people:ImportPerson[],assignments:ImportAssignment[],ctx:ImportContext,choices:PersonChoices,reference:RosterEntry[],hints:Map<number,StaffingHint>,previous:StaffingEvidence[]=[],permitted:readonly string[]=['HE','IM']){
 const records:NormalizedRow[]=[],matches:RecipientMatch[]=[],issues:{row:number;column:string;message:string}[]=[];
 for(const row of rows){
  const choice=choices[String(row.row)],hint=hints.get(row.row),weekly=ctx.phase!=='MONTH_FINALIZATION';
  const own=matchRosterMarket(row.market,rosterForMonth(reference,ctx.group,ctx.month));
  const plan=planMarketStaffing(row.market,ctx,hint?.count??null,hint?.lighthouse??false,reference,previous);
  const lh=weekly&&['HE','IM'].includes(ctx.group)?matchRosterMarket(row.market,rosterForMonth(reference,'LH',ctx.month)):null;
  const useLH=Boolean(lh?.entries.length&&(hint?.lighthouse||(!own.entries.length&&!own.ambiguous)));
  const group=useLH?'LH':ctx.group,lookup=useLH?lh!:own;
  // A Lighthouse row can also include a regular SEC of this source division.
  const refs=useLH?[...lookup.entries,...(hint?.lighthouse?own.entries:[])]:lookup.entries;
  const groups=[...new Set(refs.map(r=>r.department_id))];
  if(useLH&&!groups.includes('LH'))groups.push('LH');
  if(!groups.length)groups.push(group);
  const ids=[...new Set(refs.map(r=>r.person_id).filter((id):id is string=>Boolean(id)))];
  const shared=weekly&&(plan||useLH||ids.length>1||Boolean(hint?.count&&hint.count>1)||Array.isArray(choice));
  if(!shared){
   if(Array.isArray(choice)){
    issues.push({row:row.row,column:'',message:'Monatsabschlüsse enthalten persönliche Bewertungen und Prämien. Bitte genau eine Person je Excel-Zeile angeben.'});
    matches.push({row:row.row,sourceName:row.name,sourceExternalId:row.externalId,sourceMarket:row.market,personId:null,status:'unresolved',method:null,score:null,message:issues.at(-1)!.message});continue;
   }
   const one=resolveImportPeople([row],people,assignments,ctx.group,ctx.setting,choice?{[row.row]:choice}:{},reference,ctx.month);
   records.push(...one.records);matches.push(...one.matches.map(m=>({...m,targetGroups:[ctx.group]})));issues.push(...one.issues);continue;
  }
  const expected=plan?.expected[ctx.group as 'HE'|'IM']??hint?.count??(ids.length|| (Array.isArray(choice)?choice.length:1));
  const match:RecipientMatch={row:row.row,sourceName:row.name,sourceExternalId:row.externalId,sourceMarket:row.market,personId:null,status:'unresolved',method:null,score:lookup.score,message:'',shared:true,expectedCount:expected,targetGroup:groups.join(' / '),targetGroups:groups};
  let selected=Array.isArray(choice)?choice:typeof choice==='string'&&choice?[choice]:ids;
  if(plan&&!selected.length&&!choice&&expected===1){const one=resolveImportPeople([row],people,assignments,ctx.group,ctx.setting,{},reference,ctx.month);if(one.matches[0]?.personId)selected=[one.matches[0].personId];}
  selected=[...selected];
  if((lookup.ambiguous||useLH&&hint?.lighthouse&&own.ambiguous)&&!choice)match.message='Mehrere ähnliche Standorte gefunden. Prüfe den Markt und wähle alle zugehörigen Personen.';
  else if(new Set(selected).size!==selected.length)match.message='Eine Person ist doppelt ausgewählt. Jede Person darf nur einmal vorkommen.';
  else if(selected.length!==expected||expected<1)match.message=`Für diese Marktzeile werden ${expected} Personen benötigt. Wähle alle zugehörigen Personen und prüfe erneut.`;
  else if(!choice&&refs.some(r=>!r.person_id))match.message='Nicht alle Personen aus der Referenzliste sind mit einem aktiven SEC-Konto verknüpft.';
  const recipients:Recipient[]=[];
  if(!match.message)for(const id of selected){
   const person=people.find(p=>p.id===id);
   const personRef=refs.find(r=>r.person_id===id);
   const referenceMarket=personRef?.market;
   const personGroup=personRef?.department_id??group;
   if(!importPersonIds(assignments,reference,personGroup,personGroup==='DA'?ctx.setting:'full',ctx.month).has(id)){
    match.message='Eine gewählte Person gehört nicht zur gültigen Besetzung dieses Bereichs. Prüfe Berichtsmonat und Personenliste und wähle die passenden Personen.';break;
   }
   const eligible=assignments.filter(a=>a.person_id===id&&a.department_id===personGroup&&a.setting===(personGroup==='DA'?ctx.setting:'full')&&marketSimilarity(a.market,referenceMarket??row.market)>=.84);
   const best=Math.max(...eligible.map(a=>marketSimilarity(a.market,referenceMarket??row.market)));
   const top=eligible.filter(a=>marketSimilarity(a.market,referenceMarket??row.market)===best);
   const markets=[...new Set(top.map(a=>a.market))];
   if(markets.length>1&&new Set(markets.map(m=>marketKey(m).split(' ').sort().join(' '))).size===1)markets.splice(1);
   if(!person||markets.length!==1){match.message='Die gewählten Personen benötigen eine eindeutige Zuordnung zu diesem Markt und Bereich. Prüfe die Personenliste und die Kontenzuordnung.';break;}
   recipients.push({personId:id,name:person.name,departmentId:personGroup,market:markets[0]});
  }
  // A true source identity cannot be silently replaced by unrelated recipients.
  const exact=people.find(p=>p.external_id===row.externalId);
  if(!match.message&&exact&&!selected.includes(exact.id))match.message='Die SEC-ID gehört nicht zu den gewählten Personen. Bitte die Excel-Zeile prüfen.';
  if(!match.message&&exact&&row.name&&nameKey(exact.name)!==nameKey(row.name)){
   const identityGroup=recipients.find(r=>r.personId===exact.id)?.departmentId??group;
   const identity=resolveImportPeople([row],people,assignments,identityGroup,identityGroup==='DA'?ctx.setting:'full');
   if(identity.unresolvedCount)match.message='SEC-ID und Name widersprechen sich. Bitte die Excel-Zeile prüfen.';
  }
  match.recipients=recipients;
  if(plan)match.staffing={...staffingProgress(plan,previous,ctx.asOf,permitted),currentDivision:plan.source};
  if(match.message){issues.push({row:row.row,column:'',message:match.message});matches.push(match);continue;}
  match.status='matched';match.method=choice?'manual':'roster';match.personId=recipients[0]?.personId??null;
  match.message=`${recipients.length} ${recipients.length===1?'Person':'Personen'} · ${useLH?'LH · '+ctx.group+'-Ziele':'gemeinsame Marktziele'}. Ziele und Istwerte gelten unverändert für jede zugeordnete Person.`;
  for(const recipient of recipients){
   const person=people.find(p=>p.id===recipient.personId)!;
   const metrics=(row.normalized.metrics??[]) as {key:string;block?:string}[];
   const normalized=recipient.departmentId==='LH'&&ctx.group!=='LH'?{groupId:'LH',month:ctx.month,setting:'full',phase:ctx.phase,configurationVersion:ctx.configurationVersion,sourceGroup:ctx.group,...(ctx.targetPeriod?{targetPeriod:ctx.targetPeriod}:{}),metrics:metrics.map(m=>({...m,key:ctx.group.toLowerCase()+'-'+m.key,block:ctx.group}))}:row.normalized;
   records.push({...row,externalId:person.external_id,name:person.name,market:recipient.market,
    // Shared weekly rows retain numeric source fields, never another employee's name/ID.
    fields:Object.fromEntries(Object.entries(row.fields).filter(([key])=>!key.startsWith('person.'))),
    normalized:{...normalized,...(plan?{staffing:plan}:{}),identity:{personId:person.id,method:match.method,sharedMarket:true,sourceRow:row.row,recipientCount:recipients.length}}});
  }
  matches.push(match);
 }
 const seen=new Set<string>();
 for(const record of records){const key=[record.externalId,record.normalized.groupId,record.normalized.setting,record.market].join('|');if(seen.has(key))issues.push({row:record.row,column:'',message:'Mehrere Quellzeilen betreffen dieselbe Person und denselben Markt. Prüfe die Doppelzuordnung vor dem Speichern.'});seen.add(key);}
 return{records,matches,issues,unresolvedCount:matches.filter(m=>m.status==='unresolved').length};
}
