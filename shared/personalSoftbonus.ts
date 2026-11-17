type Criterion = {key:string;resultState?:string;achievement?:number|null};

// These original Pivot columns are conditional source blocks, not general tasks.
// An entirely blank block means no personal contribution in that closing.
const CONDITIONAL_BLOCKS:Record<string,readonly (readonly string[])[]> = {
  HE:[['softbonus.samsung-e4y','softbonus.pos-e4y']],
  DA:[['softbonus.marktzufriedenheit-elektro-k-ck','softbonus.pos-bewertung-elektro-k-ck','softbonus.s-activity-elektro-k-ck']],
};

/** Display projection only: retain supplied scores, weights and the aggregate. */
export function personalSoftbonus<T extends Criterion>(metrics:readonly T[],division:string):T[]{
  const absent=new Set((CONDITIONAL_BLOCKS[division]??[]).filter(keys=>{
    const block=metrics.filter(m=>keys.includes(m.key));
    return block.length>0&&block.every(m=>m.resultState==='not-applicable'||m.resultState==='missing'&&m.achievement==null);
  }).flat());
  return metrics.map(m=>absent.has(m.key)&&m.resultState==='missing'?{...m,resultState:'not-applicable' as const}:m);
}

export function visibleSoftbonus<T extends Criterion>(metrics:readonly T[],division:string):T[]{
  return personalSoftbonus(metrics,division).filter(m=>m.resultState!=='not-applicable');
}
