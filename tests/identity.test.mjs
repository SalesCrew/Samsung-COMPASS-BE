import assert from 'node:assert/strict';import test from 'node:test';
import {nameKey,resolveImportPeople} from '../src/identity.ts';
const people=[{id:'a',external_id:'10',name:'Anna-Lena Müller'},{id:'b',external_id:'20',name:'Peter Bauer'}];
const assignments=people.map(p=>({person_id:p.id,department_id:'HE',setting:'full',market:'Markt '+p.id}));
const row=(name,externalId='',market='Markt a')=>({row:6,name,externalId,market,fields:{},sourceShopId:null,normalized:{}});
test('name keys ignore name order, dashes, case and accents',()=>{assert.equal(nameKey('MÜLLER, anna lena'),nameKey('Anna-Lena Müller'));});
test('one clear spelling correction matches; same-name people and weak names need a choice',()=>{
 assert.equal(resolveImportPeople([row('Anna Lena Muller')],people,assignments,'HE','full').matches[0].personId,'a');
 assert.equal(resolveImportPeople([row('Anna Lena Mullerr')],people,assignments,'HE','full').matches[0].method,'fuzzy');
 assert.equal(resolveImportPeople([row('Anna Lena Muller')],[...people,{id:'c',external_id:'30',name:'Müller Anna-Lena'}],[...assignments,{...assignments[0],person_id:'c'}],'HE','full').unresolvedCount,1);
 assert.equal(resolveImportPeople([row('Anna')],people,assignments,'HE','full').unresolvedCount,1);
});
test('manual matches keep canonical identity and source provenance, and prevent conflicting IDs',()=>{
 assert.equal(resolveImportPeople([row('Different Person','10')],people,assignments,'HE','full').unresolvedCount,1);
 assert.equal(resolveImportPeople([row('MÜLLER ANNA LENA','10')],people,assignments,'HE','full').unresolvedCount,0);
 const manual=resolveImportPeople([row('Unknown','source-99')],people,assignments,'HE','full',{'6':'b'});assert.equal(manual.records[0].externalId,'20');assert.equal(manual.records[0].name,'Peter Bauer');assert.equal(manual.records[0].normalized.identity.sourceExternalId,'source-99');
 assert.equal(resolveImportPeople([row('Unknown','10')],people,assignments,'HE','full',{'6':'b'}).unresolvedCount,1);
 assert.equal(resolveImportPeople([row('Unknown')],people,assignments,'HE','full',{'6':'foreign'}).unresolvedCount,1);
 assert.equal(resolveImportPeople([row('New Person','new-99')],people,assignments,'HE','full',{'6':'new'}).matches[0].status,'new');
});
test('market-only sources need a unique assignment and duplicate resolved rows block staging',()=>{
 assert.equal(resolveImportPeople([row('')],people,assignments,'HE','full').matches[0].method,'market');
 assert.equal(resolveImportPeople([row('')],people,[...assignments,{...assignments[0],person_id:'b'}],'HE','full').unresolvedCount,1);
 assert.equal(resolveImportPeople([row('Peter Bauer')],people,assignments,'IM','full').unresolvedCount,1);
 assert.equal(resolveImportPeople([row('','10'),{...row('','10'),row:7}],people,assignments,'HE','full').issues.length,1);
});
