import test from 'node:test';import assert from 'node:assert/strict';
import {activeAssignments,activeAssignmentRows,selectedAssignment} from '../src/assignmentScope.ts';
test('archiving removes a market from active inputs while preserving original rows and zero values',()=>{
 const assignments=[{id:'live',archived_at:null},{id:'legacy'},{id:'old',archived_at:'2026-11-24'}];
 const rows=[{assignment_id:'live',points:0},{assignment_id:'legacy',points:null},{assignment_id:'old',points:3},{assignment_id:'foreign',points:3},{}];
 const before=JSON.stringify({assignments,rows});assert.deepEqual(activeAssignments(assignments).map(r=>r.id),['live','legacy']);
 assert.deepEqual(activeAssignmentRows(rows,assignments),rows.slice(0,2));assert.equal(JSON.stringify({assignments,rows}),before);
});
test('an owned archived selection recovers to an active own market; foreign and active wrong-division IDs cannot recover',()=>{
 const owned=[{id:'live'},{id:'old',archived_at:'now'},{id:'other-division'}],matching=[owned[0]];
 assert.equal(selectedAssignment('old',owned,matching),'live');assert.equal(selectedAssignment(null,owned,matching),'live');
 assert.equal(selectedAssignment('foreign',owned,matching),'foreign');assert.equal(selectedAssignment('other-division',owned,matching),'other-division');
 assert.equal(selectedAssignment('old',owned,[]),'');
});
