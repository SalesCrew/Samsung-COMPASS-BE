import test from 'node:test';
import assert from 'node:assert/strict';
import {isAdminRole,supervisorRouteAllowed} from '../src/access.ts';

test('supervisors and SECs never pass the administrator role guard',()=>{
 assert.equal(isAdminRole('supervisor'),false);assert.equal(isAdminRole('sec'),false);
 assert.equal(isAdminRole('app_admin'),true);assert.equal(isAdminRole('department_admin'),true);
});
test('supervisors may browse dashboards and manage only their own login/privacy',()=>{
 for(const path of ['/dashboard','/supervisor/people','/me','/privacy/export','/privacy/requests'])assert(supervisorRouteAllowed(path,'GET'));
 for(const path of ['/auth/password','/auth/logout','/notice','/privacy/requests'])assert(supervisorRouteAllowed(path,'POST'));
 for(const path of ['/read','/admin/data','/admin/accounts','/admin/accounts/id/reset-password','/admin/password','/imports/preview','/imports/stage','/imports/publish','/admin/configurations','/admin/security']){
  for(const method of ['GET','POST','PATCH','DELETE'])assert.equal(supervisorRouteAllowed(path,method),false,path+' '+method);
 }
});
