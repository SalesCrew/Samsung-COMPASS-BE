-- Authorization regressions run as synthetic actors; every fixture rolls back.
begin;
create temporary table supervisor_actor(n integer,user_id uuid,session_id uuid,person_id uuid,assignment_id uuid);
insert into supervisor_actor select n,gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid() from generate_series(1,10) n;
insert into auth.users(id,email,email_confirmed_at) select user_id,'supervisor-check-'||user_id||'@example.invalid',now() from supervisor_actor;
insert into auth.sessions(id,user_id) select session_id,user_id from supervisor_actor;
insert into public.sec_people(id,external_id,name)
 select person_id,'supervisor-check-'||person_id,'Synthetic supervisor subject '||n from supervisor_actor where n>=2 and n<>4;
insert into public.sec_assignments(id,person_id,department_id,setting,market)
 select assignment_id,person_id,case n when 2 then 'HE' when 3 then 'DA' when 5 then 'IM' when 6 then 'LH' when 7 then 'ST' else 'IM' end,
  case when n=3 then 'vc' else 'full' end,'Synthetic supervisor market '||n
 from supervisor_actor where n>=2 and n<>4;
insert into public.sec_accounts(user_id,email,display_name,role,department_ids,primary_department,setting,person_id,must_change_password,is_test,active)
 select user_id,'supervisor-check-'||user_id||'@example.invalid','Synthetic supervisor subject '||n,
  case when n in (1,4) then 'supervisor' else 'sec' end,
  case when n in (1,4) then '{}'::text[] else array[case n when 2 then 'HE' when 3 then 'DA' when 5 then 'IM' when 6 then 'LH' when 7 then 'ST' else 'IM' end] end,
  case n when 1 then null when 4 then null when 2 then 'HE' when 3 then 'DA' when 5 then 'IM' when 6 then 'LH' when 7 then 'ST' else 'IM' end,
  case when n=3 then 'vc' else 'full' end,case when n in (1,4) then null else person_id end,n=4,n=8,n<>9
 from supervisor_actor where n<>10;
-- Same person in an unassigned division and a foreign DA setting are not selectable.
insert into public.sec_assignments(person_id,department_id,setting,market)
 select person_id,'DA','laundry-ref','Synthetic unassigned setting' from supervisor_actor where n=3;
insert into public.sec_assignments(person_id,department_id,market)
 select person_id,'IM','Synthetic unassigned division' from supervisor_actor where n=2;
create temporary table supervisor_import(id uuid,department text);
insert into supervisor_import select gen_random_uuid(),d from unnest(array['HE','DA','IM','LH','ST']) d;
insert into public.sec_imports(id,department_id,month,phase,as_of,fingerprint,filename,sheet,mapping,status,published_at)
 select id,department,'2006-08-01','MONTH_FINALIZATION','2006-08-31',md5(id::text)||md5(id::text),'Synthetic rollback-only supervisor check','Test','[]','published',now() from supervisor_import;
insert into public.sec_monthly_reports(person_id,assignment_id,department_id,month,revision,import_id,payload)
 select a.person_id,a.id,a.department_id,'2006-08-01',1,i.id,jsonb_build_object('points',3,'sourceLevel','SEC','premium',123,'extras','[]'::jsonb,'extrasAvailable',true)
 from public.sec_assignments a join supervisor_actor t on t.assignment_id=a.id join supervisor_import i on i.department=a.department_id;
grant select on supervisor_actor to authenticated;
select set_config('request.jwt.claims',jsonb_build_object('sub',user_id,'role','authenticated','session_id',session_id,'aal','aal1')::text,true) from supervisor_actor where n=1;
set local role authenticated;
do $$declare directory jsonb;d jsonb;g jsonb;division text;a uuid;t record;begin
 directory:=public.sec_supervisor_directory();
 foreach division in array array['HE','DA','IM','LH','ST'] loop
  g:=public.sec_supervisor_group_source(division);
  if exists(select 1 from jsonb_array_elements(g->'reports') entry where entry->>'department_id'<>division) then raise exception 'Group source mixed divisions';end if;
  if exists(select 1 from jsonb_array_elements(g->'reports') entry where not exists(select 1 from jsonb_array_elements(g->'members') member where member->>'person_id'=entry->>'person_id')) then raise exception 'Group source mixed membership';end if;
  if exists(select 1 from jsonb_array_elements(g->'members') entry where entry?'email' or entry?'user_id') then raise exception 'Group source exposes account details';end if;
 end loop;
 begin perform public.sec_supervisor_group_source('invalid');raise exception 'Invalid group accepted';exception when invalid_parameter_value then null;end;

 if (select count(*) from jsonb_array_elements(directory) x join supervisor_actor fixture on fixture.assignment_id=(x->>'assignment_id')::uuid)<>5 then raise exception 'Directory eligibility incorrect';end if;
 if exists(select 1 from jsonb_array_elements(directory) x where x?'email' or x?'user_id') then raise exception 'Directory exposes unnecessary account information';end if;
 if sec_private.is_app_admin() or cardinality(sec_private.department_scope())<>0 then raise exception 'Supervisor gained admin scope';end if;
 for t in select * from supervisor_actor where n in (2,3,5,6,7) loop
  d:=public.sec_supervisor_dashboard(t.assignment_id);
  if d->'subject'->>'person_id'<>t.person_id::text or d->>'selectedAssignment'<>t.assignment_id::text or jsonb_array_length(d->'reports')<>1 then raise exception 'Wrong subject/dashboard';end if;
  if exists(select 1 from jsonb_array_elements(d->'reports') r where r->>'person_id'<>t.person_id::text) then raise exception 'Mixed subjects';end if;
  if t.n<>7 and (d->'pointHistory'->0->>'points')::numeric<>3 then raise exception 'Point history differs';end if;
 end loop;
 for a in select assignment_id from supervisor_actor where n in (8,9,10) loop
  begin perform public.sec_supervisor_dashboard(a);raise exception 'Excluded subject accepted';exception when insufficient_privilege then null;end;
 end loop;
 begin perform public.sec_supervisor_dashboard(gen_random_uuid());raise exception 'Unknown subject accepted';exception when insufficient_privilege then null;end;
 if exists(select 1 from public.sec_monthly_reports) or exists(select 1 from public.sec_weekly_snapshots) or exists(select 1 from public.sec_assignments) or exists(select 1 from public.sec_people) then raise exception 'Broad business-table access granted';end if;
 if exists(select 1 from public.sec_accounts where user_id<>(select user_id from supervisor_actor where n=1)) then raise exception 'Foreign accounts exposed';end if;
 begin update public.sec_accounts set role='app_admin' where user_id=auth.uid();raise exception 'Role escalation accepted';exception when insufficient_privilege then null;end;
 begin perform public.sec_manage_account(auth.uid(),'{"role":"app_admin"}');raise exception 'Account mutation accepted';exception when insufficient_privilege then null;end;
 begin insert into public.sec_read_receipts(user_id,report_id) select auth.uid(),(x->>'id')::uuid from jsonb_array_elements(d->'reports') x;raise exception 'Employee read state writable';exception when insufficient_privilege then null;end;
end $$;
reset role;
-- Normal SEC stays own-only and cannot open the supervisor directory/dashboard.
select set_config('request.jwt.claims',jsonb_build_object('sub',user_id,'role','authenticated','session_id',session_id,'aal','aal1')::text,true) from supervisor_actor where n=2;
set local role authenticated;
do $$begin
 perform public.sec_own_point_history((select assignment_id from supervisor_actor where n=2));
 begin perform public.sec_own_point_history((select assignment_id from supervisor_actor where n=5));raise exception 'Cross-SEC history accepted';exception when insufficient_privilege then null;end;
 begin perform public.sec_supervisor_group_source('IM');raise exception 'SEC group source accepted';exception when insufficient_privilege then null;end;
 begin perform public.sec_supervisor_directory();raise exception 'SEC directory accepted';exception when insufficient_privilege then null;end;
 begin perform public.sec_supervisor_dashboard(null);raise exception 'SEC supervisor dashboard accepted';exception when insufficient_privilege then null;end;
end $$;
reset role;
-- First-password gate is enforced directly in the database as well as the API.
select set_config('request.jwt.claims',jsonb_build_object('sub',user_id,'role','authenticated','session_id',session_id,'aal','aal1')::text,true) from supervisor_actor where n=4;
set local role authenticated;
do $$begin
 begin perform public.sec_supervisor_group_source('IM');raise exception 'Group initial-password gate bypassed';exception when insufficient_privilege then null;end;
 begin perform public.sec_supervisor_directory();raise exception 'Initial-password gate bypassed';exception when insufficient_privilege then null;end;
end $$;
reset role;
update public.sec_accounts set active=false where user_id=(select user_id from supervisor_actor where n=1);
select set_config('request.jwt.claims',jsonb_build_object('sub',user_id,'role','authenticated','session_id',session_id,'aal','aal1')::text,true) from supervisor_actor where n=1;
set local role authenticated;
do $$begin begin perform public.sec_supervisor_directory();raise exception 'Disabled supervisor accepted';exception when insufficient_privilege then null;end;end $$;
reset role;
update public.sec_accounts set active=true where user_id=(select user_id from supervisor_actor where n=1);
delete from auth.sessions where user_id=(select user_id from supervisor_actor where n=1);
set local role authenticated;
do $$begin begin perform public.sec_supervisor_directory();raise exception 'Revoked session accepted';exception when insufficient_privilege then null;end;end $$;
reset role;
set local role anon;
do $$begin begin perform public.sec_supervisor_directory();raise exception 'Anonymous directory accepted';exception when insufficient_privilege then null;end;begin perform public.sec_supervisor_group_source('IM');raise exception 'Anonymous group source accepted';exception when insufficient_privilege then null;end;end $$;
reset role;
rollback;
select 'supervisor read-only scope, eligibility, subject views, first-password gate and revocation passed; fixtures rolled back' as verification;
