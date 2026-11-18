import type {ImportPerson,ImportAssignment} from './identity.ts';
import {rosterForMonth,type RosterEntry} from './roster.ts';

type SelectionContext={group:string;setting:string;month:string;phase:string};

/** A roster is authoritative from its source month, never retroactively.
 * Without an older roster, retain the division's historical assignments for backfills.
 * Account activation is deliberately irrelevant: leaving employment must not erase history.
 */
export function importPersonIds(assignments:ImportAssignment[],reference:RosterEntry[],group:string,setting:string,month:string){
 const roster=rosterForMonth(reference,group,month);
 const rosterIds=new Set(roster.map(r=>r.person_id).filter(Boolean));
 return new Set(assignments.filter(a=>a.department_id===group&&a.setting===setting&&(!roster.length||rosterIds.has(a.person_id))).map(a=>a.person_id));
}

export function importPeopleOptions(people:ImportPerson[],assignments:ImportAssignment[],reference:RosterEntry[],ctx:SelectionContext){
 const groups=[ctx.group,...(ctx.phase!=='MONTH_FINALIZATION'&&['HE','IM'].includes(ctx.group)?['LH']:[])];
 const eligible=new Map(groups.map(group=>[group,importPersonIds(assignments,reference,group,group==='DA'?ctx.setting:'full',ctx.month)]));
 return people.flatMap(person=>{
  const departments=groups.filter(group=>eligible.get(group)!.has(person.id));
  if(!departments.length)return [];
  const markets=[...new Set(assignments.filter(a=>a.person_id===person.id&&departments.includes(a.department_id)&&a.setting===(a.department_id==='DA'?ctx.setting:'full')).map(a=>a.market))];
  const aliases=[...new Set([...(person.source_aliases??[]),...departments.flatMap(group=>rosterForMonth(reference,group,ctx.month).filter(r=>r.person_id===person.id).map(r=>r.email?.split('@')[0]).filter((alias):alias is string=>Boolean(alias)))])];
  return [{...person,department_ids:departments,markets,...(aliases.length?{aliases}:{})}];
 }).sort((a,b)=>a.name.localeCompare(b.name,'de-AT')||a.external_id.localeCompare(b.external_id));
}
