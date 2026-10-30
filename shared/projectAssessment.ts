export type AssessmentDetail = {key:string;label:string;achievement:number|null;resultState:'value'|'missing'|'invalid'|'not-applicable'};
export const PROJECT_ASSESSMENT_ITEMS = [
  ['softbonus.qualit-t-und-schnelligkeit-von-reportingaufgaben-inkl-market-sensing','Qualität & Schnelligkeit im Reporting (inkl. Market Sensing)'],
  ['softbonus.zustand-pos-sauberkeit-werbematerial-etc','Zustand POS (Sauberkeit, Werbematerial etc.)'],
  ['softbonus.namensschild-shirt-gepflegtes-auftreten','Namensschild, Shirt & gepflegtes Auftreten'],
  ['softbonus.m-ngel-sch-den-am-pos','Mängel & Schäden am POS'],
  ['softbonus.umsetzung-allgem-aufgaben-d-sv','Umsetzung allgemeiner Aufgaben des Supervisors'],
  ['softbonus.samsung-activity','Samsung+ Activity'],
] as const;
export const isProjectAssessment=(key:string)=>key==='project'||key==='softbonus.pl-bewertung';
/** Existing source values move under their supplied parent; the aggregate is never recalculated. */
export function groupProjectAssessment<T extends AssessmentDetail & {details?:AssessmentDetail[]}>(metrics:readonly T[]):T[]{
  const parent=metrics.find(m=>isProjectAssessment(m.key));
  if(!parent)return [...metrics];
  const children=PROJECT_ASSESSMENT_ITEMS.flatMap(([key,label])=>{
    const source=metrics.find(m=>m.key===key);
    return source?[{key,label,achievement:source.achievement,resultState:source.resultState}]:[];
  });
  if(!children.length)return metrics.map(m=>m===parent?{...m,label:'Projektleiterbewertung'}:m);
  return metrics.filter(m=>!PROJECT_ASSESSMENT_ITEMS.some(([key])=>key===m.key)).map(m=>m===parent?{...m,label:'Projektleiterbewertung',details:children}:m);
}
/** Fictional presentation only; never use to fill missing employee assessment data. */
export function presentationProjectDetails(achievement:number):AssessmentDetail[]{
  const offsets=achievement>98||achievement<2?[0,0,0,0,0,0]:[2,0,2,-2,-1,-1];
  return PROJECT_ASSESSMENT_ITEMS.map(([key,label],i)=>({key,label,achievement:achievement+offsets[i],resultState:'value'}));
}
