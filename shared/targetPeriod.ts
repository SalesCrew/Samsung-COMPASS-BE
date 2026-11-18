export type TargetPeriod={from:string;through:string};
export type TargetPeriodCoverage={period:TargetPeriod|null;known:number;total:number;different:boolean};

export type TargetPeriodStand={month:string;setting:string;groupId?:string;sourceGroup?:string;assignmentId?:string;asOf:string;updatedAt:string;targetPeriod?:unknown};
/** A monthly note survives a later blank weekly upload in the same assignment
 * and source block. Explicit null/invalid notes stop inheritance. Never select
 * data by these dates or borrow a note from another month, person or LH block. */
export function targetPeriodForStand(stand:TargetPeriodStand,history:readonly TargetPeriodStand[]):TargetPeriod|null{
 if(stand.targetPeriod!==undefined)return readTargetPeriod(stand.targetPeriod);
 const earlier=history.filter(row=>row.month.slice(0,7)===stand.month.slice(0,7)&&row.setting===stand.setting&&row.groupId===stand.groupId&&row.sourceGroup===stand.sourceGroup&&row.assignmentId===stand.assignmentId&&row.asOf<stand.asOf)
  .sort((a,b)=>b.asOf.localeCompare(a.asOf)||b.updatedAt.localeCompare(a.updatedAt));
 const active=new Map<string,TargetPeriodStand>();
 for(const row of earlier)if(!active.has(row.asOf))active.set(row.asOf,row);
 const declared=[...active.values()].find(row=>row.targetPeriod!==undefined);
 return declared?readTargetPeriod(declared.targetPeriod):null;
}

export function validISODate(value:unknown):value is string{
 if(typeof value!=='string'||!/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(value))return false;
 const date=new Date(value+'T12:00:00Z');return Number.isFinite(date.valueOf())&&date.toISOString().slice(0,10)===value;
}
/** Display-only context. These dates never select or limit the target data. */
export function readTargetPeriod(value:unknown):TargetPeriod|null{
 if(!value||typeof value!=='object'||Array.isArray(value))return null;
 const period=value as Record<string,unknown>;
 if(Object.keys(period).some(k=>k!=='from'&&k!=='through')||!validISODate(period.from)||!validISODate(period.through)||period.from>period.through)return null;
 return{from:period.from,through:period.through};
}
export function sameTargetPeriod(a:unknown,b:unknown):boolean{
 if(a==null&&b==null)return true;
 const x=readTargetPeriod(a),y=readTargetPeriod(b);return !!x&&!!y&&x.from===y.from&&x.through===y.through;
}
export function summarizeTargetPeriods(values:readonly unknown[]):TargetPeriodCoverage{
 const periods=values.map(v=>readTargetPeriod(v)).filter((p):p is TargetPeriod=>p!==null);
 const different=periods.some(p=>!sameTargetPeriod(p,periods[0]));
 return{period:different?null:periods[0]??null,known:periods.length,total:values.length,different};
}
export function targetPeriodLabel(period:TargetPeriod):string{
 const day=(s:string)=>s.slice(8,10)+'.'+s.slice(5,7)+'.';
 return day(period.from)+(period.from.slice(0,4)===period.through.slice(0,4)?'':period.from.slice(0,4))+'–'+day(period.through)+period.through.slice(0,4);
}

/** An explicit campaign title may name a whole target window. EDI rows describe
 * measured data, so they must never be mistaken for a target's validity. */
export function targetPeriodFromTitle(title:string):TargetPeriod|null{
 const month=title.match(/\bMonthly\s+(\d{4})(0[1-9]|1[0-2])\b/i);
 if(!month)return null;
 const range=title.match(/\(\s*(\d{1,2})\.(\d{1,2})\.(?:(\d{4}))?\s*[-–]\s*(\d{1,2})\.(\d{1,2})\.(\d{4})\s*\)/);
 if(!range)return null;
 const year=Number(range[6]),firstYear=range[3]?Number(range[3]):year-(Number(range[2])>Number(range[5])?1:0);
 return readTargetPeriod({from:firstYear+'-'+range[2].padStart(2,'0')+'-'+range[1].padStart(2,'0'),through:year+'-'+range[5].padStart(2,'0')+'-'+range[4].padStart(2,'0')});
}
