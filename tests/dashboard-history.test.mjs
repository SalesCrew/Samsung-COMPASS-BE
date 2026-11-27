import test from 'node:test';
import assert from 'node:assert/strict';
import {dashboardPremiumRows,pendingMarketRanking} from '../src/dashboardHistory.ts';
import {ownPremiumHistory} from '../src/premiumHistory.ts';

test('a market dashboard keeps only that market premium history and its own latest correction',()=>{
 const row=(assignment_id,revision,premium)=>({id:assignment_id+revision,person_id:'own',department_id:'IM',assignment_id,month:'2026-01-01',revision,payload:{premium,extrasAvailable:true,extras:[]}});
 const rows=[row('north',1,100),row('north',2,120),row('south',1,300)];
 const before=JSON.stringify(rows);
 assert.equal(ownPremiumHistory(dashboardPremiumRows(rows,'assignment','north'),'own','IM')[0].premium,120);
 assert.equal(ownPremiumHistory(dashboardPremiumRows(rows,'assignment','south'),'own','IM')[0].premium,300);
 assert.equal(ownPremiumHistory(dashboardPremiumRows(rows,'division','north'),'own','IM')[0].premium,null);
 assert.deepEqual(dashboardPremiumRows(rows,'assignment','foreign'),[]);
 assert.equal(JSON.stringify(rows),before);
});
test('separate market dashboards do not invent a per-market rank or comparison cohort',()=>{
 assert.deepEqual(pendingMarketRanking(),{pool:0,rank:null,outsideTopTen:false,reason:'market-scope'});
});
