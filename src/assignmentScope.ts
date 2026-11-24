type Assignment = {id?:unknown;archived_at?:unknown};
/** Published originals remain stored; archived markets leave active views. */
export function activeAssignments<T extends Assignment>(rows:readonly T[]):T[]{return rows.filter(row=>row.archived_at==null);}
export function activeAssignmentRows<T extends {assignment_id?:unknown}>(rows:readonly T[],assignments:readonly Assignment[]):T[]{
 const ids=new Set(activeAssignments(assignments).flatMap(row=>typeof row.id==='string'?[row.id]:[]));return rows.filter(row=>typeof row.assignment_id==='string'&&ids.has(row.assignment_id));
}
/** Recover only an owned, archived selection; foreign IDs remain forbidden. */
export function selectedAssignment(requested:string|null,owned:readonly Assignment[],matching:readonly Assignment[]):string{
 if(requested&&owned.some(row=>row.id===requested&&row.archived_at!=null))return String(matching.at(-1)?.id??'');
 return requested??String(matching.at(-1)?.id??'');
}
