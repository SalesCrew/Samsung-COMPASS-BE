import test from'node:test';import assert from'node:assert/strict';import{correctedWeeklyScope}from'../src/weeklyScope.ts';
const old={id:'old',person_id:'a',assignment_id:'old-assignment',department_id:'HE',month:'2026-11-01',as_of:'2026-11-09',payload:{}},replacement={...old,id:'new',assignment_id:'new-assignment',department_id:'LH',payload:{sourceGroup:'HE'}};
const assignments=[{id:'old-assignment',market:'MM Musterstadt 7'},{id:'new-assignment',market:'Media Markt Musterstadt 7'}],reference=[{id:'old-ref',person_id:'a',department_id:'HE',market:'MM Musterstadt 7',source_month:'2026-10',source_hash:'a'.repeat(64),imported_at:'2026-10-01'},{id:'new-ref',person_id:'a',department_id:'LH',market:'MM Musterstadt 7',source_month:'2026-11',source_hash:'b'.repeat(64),imported_at:'2026-11-18'},{id:'remaining-he',person_id:'b',department_id:'HE',market:'MM Other City',source_month:'2026-11',source_hash:'b'.repeat(64),imported_at:'2026-11-18'}];
test('a source-backed correction removes the old division from current charts without mutating stored rows',()=>{
 const rows=[old,replacement],before=JSON.stringify(rows);assert.deepEqual(correctedWeeklyScope(rows,assignments,reference),[replacement]);assert.equal(JSON.stringify(rows),before);
 const reverse=[{...old,department_id:'LH',payload:{sourceGroup:'HE'}},{...replacement,department_id:'HE',payload:{}}];const refs=reference.map(r=>({...r,department_id:r.department_id==='HE'?'LH':'HE'}));assert.deepEqual(correctedWeeklyScope(reverse,assignments,refs),[reverse[1]]);
});
test('history, missing replacements, other source blocks, dates, branches and valid dual assignments stay visible',()=>{
 assert.deepEqual(correctedWeeklyScope([old],assignments,reference),[old]);
 for(const other of[{...replacement,as_of:'2026-11-16'},{...replacement,payload:{sourceGroup:'IM'}}])assert.equal(correctedWeeklyScope([old,other],assignments,reference).length,2);
 assert.equal(correctedWeeklyScope([old,replacement],assignments.map(a=>a.id==='new-assignment'?{...a,market:'MM Musterstadt 8'}:a),reference).length,2);
 const past=[{...old,month:'2026-10-01',as_of:'2026-10-09'},replacement];assert.equal(correctedWeeklyScope(past,assignments,reference).length,2);
 assert.equal(correctedWeeklyScope([old,replacement],assignments,[...reference,{...reference[0],id:'also-current',source_month:'2026-11',imported_at:'2026-11-18'}]).length,2);
});
