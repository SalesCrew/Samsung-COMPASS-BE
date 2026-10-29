-- Run against the SEC test/production schema after the migration. All fixture writes roll back.
begin;
create temporary table rank_actor(user_id uuid,session_id uuid);
insert into rank_actor values(gen_random_uuid(),gen_random_uuid());
insert into auth.users(id,email) select user_id,'rolling-rank-test@example.invalid' from rank_actor;
insert into auth.sessions(id,user_id) select session_id,user_id from rank_actor;
create temporary table rank_case(n integer,department text,person_id uuid,assignment_id uuid,primary key(n,department));
insert into rank_case select n,d,gen_random_uuid(),gen_random_uuid() from generate_series(1,17) n cross join unnest(array['IM','DA']) d;
insert into public.sec_people(id,external_id,name) select person_id,'rolling-test-'||person_id,'Synthetic rolling test' from rank_case;
insert into public.sec_assignments(id,person_id,department_id,market,setting)
 select assignment_id,person_id,department,'Synthetic rolling market',case when department='DA' and n%2=0 then 'vc' else 'full' end from rank_case;
create temporary table rank_import(month date,department text,id uuid,primary key(month,department));
insert into rank_import select m::date,d,gen_random_uuid() from generate_series('2005-09-01'::date,'2006-08-01'::date,interval '1 month') m cross join unnest(array['IM','DA','LH']) d;
insert into public.sec_imports(id,department_id,month,phase,as_of,fingerprint,filename,sheet,mapping,status,published_at)
 select id,department,month,'MONTH_FINALIZATION',(month+interval '1 month - 1 day')::date,md5(id::text)||md5(id::text),'Synthetic rollback-only closing','Test','[]','published',now() from rank_import;
insert into public.sec_monthly_reports(person_id,assignment_id,department_id,month,revision,import_id,payload)
 select c.person_id,c.assignment_id,c.department,i.month,1,i.id,
  jsonb_build_object('groupId',c.department,'month',to_char(i.month,'YYYY-MM'),'points',least(3,greatest(0,37-c.n-(extract(year from age(i.month,'2005-09-01'::date))*12+extract(month from age(i.month,'2005-09-01'::date))))),'sourceLevel',null)
 from rank_case c join rank_import i on i.department=c.department
 where c.n<>16 or i.month<>'2005-09-01';
-- Use exact distinct totals 36,35,...,22 for the first fifteen people.
update public.sec_monthly_reports r set payload=jsonb_set(payload,'{points}',to_jsonb(least(3,greatest(0,37-c.n-3*(extract(year from age(r.month,'2005-09-01'::date))*12+extract(month from age(r.month,'2005-09-01'::date)))))::numeric))
 from rank_case c where r.person_id=c.person_id;
-- A second market with identical monthly points must not double the person or their points.
create temporary table rank_second(id uuid);
insert into rank_second values(gen_random_uuid());
insert into public.sec_assignments(id,person_id,department_id,market) select s.id,c.person_id,'IM','Synthetic second market' from rank_second s cross join rank_case c where c.n=1 and c.department='IM';
insert into public.sec_monthly_reports(person_id,assignment_id,department_id,month,revision,import_id,payload)
 select r.person_id,s.id,r.department_id,r.month,1,r.import_id,r.payload from public.sec_monthly_reports r cross join rank_second s join rank_case c on c.person_id=r.person_id where c.n=1 and c.department='IM';
-- Conflicting values within a person/month are unavailable, not summed or chosen arbitrarily.
insert into public.sec_assignments(person_id,department_id,market)
 select person_id,'IM','Synthetic conflicting market' from rank_case where n=17 and department='IM';
insert into public.sec_monthly_reports(person_id,assignment_id,department_id,month,revision,import_id,payload)
 select c.person_id,a.id,'IM','2006-08-01',1,i.id,jsonb_build_object('groupId','IM','month','2006-08','points',3)
 from rank_case c join public.sec_assignments a on a.person_id=c.person_id and a.market='Synthetic conflicting market'
 join rank_import i on i.month='2006-08-01' and i.department='IM' where c.n=17 and c.department='IM';
-- DA test person 17 is also incomplete, leaving fifteen comparable people in both divisions.
delete from public.sec_monthly_reports r using rank_case c where c.n=17 and c.department='DA' and r.person_id=c.person_id and r.month='2005-09-01';
insert into public.sec_accounts(user_id,email,display_name,role,department_ids,primary_department,person_id,must_change_password,is_test)
 select u.user_id,'rolling-rank-test@example.invalid','Synthetic rolling verifier','sec',array['IM'],'IM',c.person_id,false,true from rank_actor u cross join rank_case c where c.n=1 and c.department='IM';
grant select on rank_actor,rank_case,rank_second to authenticated;
select set_config('request.jwt.claims',jsonb_build_object('sub',user_id,'role','authenticated','session_id',session_id,'aal','aal1')::text,true) from rank_actor;
set local role authenticated;
do $$declare assignment uuid; result jsonb; history jsonb; begin
 select assignment_id into assignment from pg_temp.rank_case where n=1 and department='IM';
 result:=public.sec_own_rank(assignment,'2006-08-01');
 if result->>'pool'<>'15' or result->>'rank'<>'1' then raise exception 'Own rolling rank or person dedup failed: %',result; end if;
 history:=public.sec_own_point_history(assignment);
 if jsonb_array_length(history)<>12 or (select sum((e->>'points')::numeric) from jsonb_array_elements(history) e)<>36 then raise exception 'Own point projection duplicated markets'; end if;
 if exists(select 1 from jsonb_array_elements(history) e where e ? 'person_id' or e ? 'premium' or e ? 'name') then raise exception 'Projection disclosed extra fields'; end if;
 begin perform public.sec_own_rank((select assignment_id from pg_temp.rank_case where n=2 and department='IM'),'2006-08-01');raise exception 'Foreign rank allowed'; exception when insufficient_privilege then null; end;
 begin perform public.sec_own_point_history((select assignment_id from pg_temp.rank_case where n=1 and department='DA'));raise exception 'Other division allowed'; exception when insufficient_privilege then null; end;
 begin perform * from sec_private.monthly_point_history('IM','2005-09-01','2006-08-01',null);raise exception 'Internal helper exposed'; exception when insufficient_privilege then null; end;
end $$;
reset role;
-- Move the same isolated actor through distinct scopes, never touching a real account.
update public.sec_accounts set person_id=(select person_id from rank_case where n=14 and department='IM') where user_id=(select user_id from rank_actor);
set local role authenticated;
do $$declare result jsonb;begin result:=public.sec_own_rank((select assignment_id from pg_temp.rank_case where n=14 and department='IM'),'2006-08-01');if result->>'rank' is not null or result->>'outsideTopTen'<>'true' or result->>'pool'<>'15' then raise exception 'Outside top ten disclosed a rank or was hidden';end if;end $$;
reset role;
update public.sec_accounts set person_id=(select person_id from rank_case where n=16 and department='IM') where user_id=(select user_id from rank_actor);
set local role authenticated;
do $$declare result jsonb;begin result:=public.sec_own_rank((select assignment_id from pg_temp.rank_case where n=16 and department='IM'),'2006-08-01');if result->>'reason'<>'incomplete-history' or result->>'rank' is not null then raise exception 'Missing history was ranked';end if;end $$;
reset role;
-- A prior-year correction replaces the monthly contribution instead of being added.
insert into public.sec_monthly_reports(person_id,assignment_id,department_id,month,revision,import_id,payload)
 select r.person_id,r.assignment_id,r.department_id,r.month,2,r.import_id,jsonb_set(r.payload,'{points}','0') from public.sec_monthly_reports r join rank_case c on c.person_id=r.person_id where c.n=2 and c.department='IM' and r.month='2005-09-01';
update public.sec_accounts set person_id=(select person_id from rank_case where n=2 and department='IM') where user_id=(select user_id from rank_actor);
set local role authenticated;
do $$declare result jsonb;begin result:=public.sec_own_rank((select assignment_id from pg_temp.rank_case where n=2 and department='IM'),'2006-08-01');if result->>'rank'<>'4' then raise exception 'Rolling correction or shared-rank ordering failed: %',result;end if;end $$;
reset role;
update public.sec_accounts set person_id=(select person_id from rank_case where n=1 and department='DA'),department_ids=array['DA'],primary_department='DA',setting='full' where user_id=(select user_id from rank_actor);
set local role authenticated;
do $$declare result jsonb;begin result:=public.sec_own_rank((select assignment_id from pg_temp.rank_case where n=1 and department='DA'),'2006-08-01');if result->>'pool'<>'15' or result->>'rank'<>'1' then raise exception 'Division ranking incorrectly split DA settings';end if;end $$;
reset role;
update public.sec_accounts set must_change_password=true where user_id=(select user_id from rank_actor);
set local role authenticated;
do $$begin begin perform public.sec_own_point_history((select assignment_id from pg_temp.rank_case where n=1 and department='DA'));raise exception 'Initial password bypassed';exception when insufficient_privilege then null;end;end $$;
reset role;
-- Small and inapplicable divisions return a reason without exposing a peer count.
insert into public.sec_assignments(person_id,department_id,market)
 select person_id,d,'Synthetic small division' from rank_case cross join unnest(array['LH','ST']) d where n=1 and department='IM';
insert into public.sec_monthly_reports(person_id,assignment_id,department_id,month,revision,import_id,payload)
 select r.person_id,a.id,'LH',r.month,1,i.id,jsonb_set(r.payload,'{groupId}','"LH"')
 from public.sec_monthly_reports r join rank_case c on c.person_id=r.person_id and c.n=1 and c.department='IM'
 join public.sec_assignments a on a.person_id=c.person_id and a.department_id='LH'
 join rank_import i on i.department='LH' and i.month=r.month where r.assignment_id=c.assignment_id;
update public.sec_accounts set must_change_password=false,person_id=(select person_id from rank_case where n=1 and department='IM'),department_ids=array['LH'],primary_department='LH' where user_id=(select user_id from rank_actor);
set local role authenticated;
do $$declare result jsonb;begin
 result:=public.sec_own_rank((select id from public.sec_assignments where market='Synthetic small division' and department_id='LH'),'2006-08-01');
 if result->>'pool'<>'0' or result->>'rank' is not null or result->>'reason'<>'not-enough-participants' then raise exception 'Small division exposed a rank';end if;
end $$;
reset role;
update public.sec_accounts set department_ids=array['ST'],primary_department='ST' where user_id=(select user_id from rank_actor);
set local role authenticated;
do $$declare result jsonb;assignment uuid;begin
 select id into assignment from public.sec_assignments where market='Synthetic small division' and department_id='ST';
 result:=public.sec_own_rank(assignment,'2006-08-01');
 if result->>'pool'<>'0' or result->>'rank' is not null or public.sec_own_point_history(assignment)<>'[]'::jsonb then raise exception 'ST received an invented point/rank model';end if;
end $$;
reset role;
update public.sec_accounts set active=false where user_id=(select user_id from rank_actor);
set local role authenticated;
do $$begin begin perform public.sec_own_point_history(gen_random_uuid());raise exception 'Disabled actor allowed';exception when insufficient_privilege then null;end;end $$;
reset role;
set local role anon;
do $$begin begin perform public.sec_own_point_history(gen_random_uuid());raise exception 'Anonymous projection allowed';exception when insufficient_privilege then null;end;end $$;
reset role;
rollback;
