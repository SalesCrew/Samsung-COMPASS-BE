-- Every synthetic identity, session, reference and publication is rolled back.
begin;
create temporary table multi_actor(n integer,user_id uuid,session_id uuid,person_id uuid,external_id text);
insert into multi_actor select n,gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),'multi-'||gen_random_uuid() from generate_series(1,5) n;
insert into auth.users(id,email,email_confirmed_at) select user_id,'multi-'||user_id||'@example.invalid',now() from multi_actor;
insert into auth.sessions(id,user_id) select session_id,user_id from multi_actor;
insert into public.sec_people(id,external_id,name) select person_id,external_id,'Synthetic multi subject' from multi_actor where n in (2,3,4);
insert into public.sec_accounts(user_id,email,display_name,role,department_ids,primary_department,person_id,must_change_password,is_test,active)
 select user_id,'multi-'||user_id||'@example.invalid','Synthetic multi verifier',case when n=1 then 'app_admin' when n=5 then 'department_admin' else 'sec' end,
 case when n in (2,3) then array['LH'] when n in (4,5) then array['HE'] else '{}'::text[] end,
 case when n in (2,3) then 'LH' when n=4 then 'HE' else null end,case when n in (2,3,4) then person_id else null end,false,true,true from multi_actor;
insert into public.sec_assignments(person_id,department_id,setting,market) select person_id,case when n=4 then 'HE' else 'LH' end,'full','Synthetic multi market' from multi_actor where n in (2,3,4);
insert into public.sec_roster_entries(email,department_id,first_name,last_name,market,person_id,source_month,source_hash,source_row)
 select 'multi-'||user_id||'@example.invalid','LH','Synthetic','Subject','Synthetic multi market',person_id,'2006-10',md5('multi-test')||md5('multi-test'),n from multi_actor where n in (2,3);
grant select on multi_actor to authenticated;
select set_config('request.jwt.claims',jsonb_build_object('sub',user_id,'role','authenticated','session_id',session_id,'aal','aal1')::text,true) from multi_actor where n=1;
set local role authenticated;
do $$declare rows jsonb;batch public.sec_imports;again public.sec_imports;begin
 select jsonb_agg(jsonb_build_object('row',2,'externalId',external_id,'name','Synthetic multi subject','market','Synthetic multi market','fields','{}'::jsonb,'normalized',jsonb_build_object('groupId','LH','month','2006-10','setting','full','sourceGroup','HE','metrics',jsonb_build_array(jsonb_build_object('key','he-units','actual',-2,'target',10))))) into rows from multi_actor where n in (2,3);
 batch:=public.sec_stage_import('HE','2006-10-01','WEEKLY_PROGRESS','2006-10-07',repeat('1',64),'Synthetic multi HE','Weekly','[]',null,rows);
 again:=public.sec_stage_import('HE','2006-10-01','WEEKLY_PROGRESS','2006-10-07',repeat('1',64),'Synthetic multi HE','Weekly','[]',null,rows);
 if batch.id<>again.id or batch.row_count<>2 then raise exception 'Recipient/idempotency failure';end if;
 perform public.sec_publish_import(batch.id);perform public.sec_publish_import(batch.id);
 if (select count(*) from public.sec_weekly_snapshots where import_id=batch.id)<>2 then raise exception 'Publish must reach both exactly once';end if;
 if exists(select 1 from public.sec_weekly_snapshots where import_id=batch.id and (department_id<>'LH' or (payload->'metrics'->0->>'actual')::numeric<>-2)) then raise exception 'Recipient value/context changed';end if;
 rows:=replace(rows::text,'"HE"','"IM"')::jsonb;rows:=replace(rows::text,'he-units','im-flagship')::jsonb;
 batch:=public.sec_stage_import('IM','2006-10-01','WEEKLY_PROGRESS','2006-10-07',repeat('2',64),'Synthetic multi IM','Weekly','[]',null,rows);perform public.sec_publish_import(batch.id);
 if (select count(*) from public.sec_weekly_snapshots w join multi_actor a on a.person_id=w.person_id where w.month='2006-10-01')<>4 then raise exception 'HE/IM components overwritten';end if;
 begin perform public.sec_stage_import('IM','2006-10-01','MONTH_FINALIZATION','2006-10-31',repeat('3',64),'Synthetic invalid closing','Pivot Liste','[]',null,rows);raise exception 'Cross-division payout accepted';exception when raise_exception then if sqlerrm='Cross-division payout accepted' then raise;end if;end;
end $$;
reset role;
-- SEC reads only its own LH components, never the other recipient or source division.
select set_config('request.jwt.claims',jsonb_build_object('sub',user_id,'role','authenticated','session_id',session_id,'aal','aal1')::text,true) from multi_actor where n=2;
set local role authenticated;
do $$begin
 if (select count(*) from public.sec_weekly_snapshots)<>2 then raise exception 'Own recipient components missing or foreign rows exposed';end if;
 if exists(select 1 from public.sec_weekly_snapshots where department_id<>'LH') or exists(select 1 from public.sec_roster_entries) then raise exception 'LH role/scope broadened';end if;
end $$;
reset role;
-- A HE-only administrator cannot stage an LH recipient through a HE import.
select set_config('request.jwt.claims',jsonb_build_object('sub',user_id,'role','authenticated','session_id',session_id,'aal','aal1')::text,true) from multi_actor where n=5;
set local role authenticated;
do $$declare rows jsonb;begin
 if exists(select 1 from public.sec_import_rows where normalized->>'groupId'='LH') then raise exception 'Source administrator accessed LH raw rows';end if;
 select jsonb_build_array(jsonb_build_object('row',2,'externalId',external_id,'name','Synthetic multi subject','market','Synthetic multi market','fields','{}'::jsonb,'normalized',jsonb_build_object('groupId','LH','month','2006-10','setting','full','sourceGroup','HE','metrics','[]'::jsonb))) into rows from multi_actor where n=2;
 begin perform public.sec_stage_import('HE','2006-10-01','WEEKLY_PROGRESS','2006-10-09',repeat('4',64),'Synthetic denied','Weekly','[]',null,rows);raise exception 'Department boundary bypassed';exception when insufficient_privilege then null;end;
end $$;
reset role;
rollback;
select 'Multi-recipient staging/publication, idempotency, LH component preservation and own-only RLS passed; all fixtures rolled back.' as verification;
