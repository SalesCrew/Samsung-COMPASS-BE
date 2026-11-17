import type {CellComment} from '../shared/excelComments.ts';
export type ReportComments={report_id:string;metric_key:string;comments:CellComment[]};

/** Historical annotations are tied to an immutable publication, never to a name or latest month. */
export function withReportComments(rows:Record<string,unknown>[],notes:readonly ReportComments[]):Record<string,unknown>[]{
  const reports=new Map<string,Map<string,CellComment[]>>();
  for(const note of notes){
    if(!reports.has(note.report_id))reports.set(note.report_id,new Map());
    reports.get(note.report_id)!.set(note.metric_key,note.comments);
  }
  return rows.map(row=>{
    const own=reports.get(String(row.id));
    if(!own||!row.payload||typeof row.payload!=='object')return row;
    const payload=row.payload as Record<string,unknown>;
    const apply=(values:unknown):unknown=>Array.isArray(values)?values.map(value=>{
      if(!value||typeof value!=='object')return value;
      const metric=value as Record<string,unknown>,comments=own.get(String(metric.key));
      return {...metric,...(comments&&!(Array.isArray(metric.comments)&&metric.comments.length)?{comments}:{}),...(Array.isArray(metric.details)?{details:apply(metric.details)}:{})};
    }):values;
    return {...row,payload:{...payload,...(Array.isArray(payload.metrics)?{metrics:apply(payload.metrics)}:{}),...(Array.isArray(payload.qualitative)?{qualitative:apply(payload.qualitative)}:{})}};
  });
}
