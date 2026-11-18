import{rosterForMonth,marketKey,type RosterEntry}from'./roster.ts';
type Row={person_id:string;assignment_id:string;department_id:string;month:string;as_of:string;payload:{sourceGroup?:string}};
type Assignment={id:string;market:string};
/** Keep original revisions in storage. A proven same-source replacement in the
 * dated roster's corrected division supersedes an old misclassified chart row.
 * Missing replacements, older months and independently valid divisions remain.
 */
export function correctedWeeklyScope<T extends Row>(rows:T[],assignments:Assignment[],reference:RosterEntry[]):T[]{
 const markets=new Map(assignments.map(a=>[a.id,marketKey(a.market).split(' ').sort().join(' ')]));
 const memberships=new Map<string,Set<string>>();
 for(const month of new Set(rows.map(r=>r.month.slice(0,7))))for(const group of['HE','IM','DA','LH','ST'])for(const entry of rosterForMonth(reference,group,month))if(entry.person_id){const key=entry.person_id+'|'+month;const groups=memberships.get(key)??new Set<string>();groups.add(group);memberships.set(key,groups);}
 const current=(row:Row)=>memberships.get(row.person_id+'|'+row.month.slice(0,7));
 const key=(row:Row)=>[row.person_id,row.month,row.as_of,row.payload.sourceGroup??row.department_id,markets.get(row.assignment_id)].join('|');
 const replacements=new Set(rows.filter(r=>current(r)?.has(r.department_id)&&markets.has(r.assignment_id)).map(key));
 return rows.filter(r=>!current(r)?.size||current(r)!.has(r.department_id)||!markets.has(r.assignment_id)||!replacements.has(key(r)));
}
