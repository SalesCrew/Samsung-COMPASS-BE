-- Synthetic authentication and imports exist only inside this transaction.
begin;
create temporary table signed_import_actor(user_id uuid,session_id uuid,external_id text);
insert into signed_import_actor select gen_random_uuid(),gen_random_uuid(),'signed-import-'||gen_random_uuid();
insert into auth.users(id,email,email_confirmed_at) select user_id,'signed-import-'||user_id||'@example.invalid',now() from signed_import_actor;
insert into auth.sessions(id,user_id) select session_id,user_id from signed_import_actor;
insert into public.sec_accounts(user_id,email,display_name,role,department_ids,must_change_password,is_test,active)
 select user_id,'signed-import-'||user_id||'@example.invalid','Synthetic signed-import test','app_admin','{}',false,true,true from signed_import_actor;
grant select on signed_import_actor to authenticated;
select set_config('request.jwt.claims',jsonb_build_object('sub',user_id,'role','authenticated','session_id',session_id,'aal','aal1')::text,true) from signed_import_actor;
set local role authenticated;
do $$declare batch public.sec_imports;again public.sec_imports;rows jsonb;ext text;actual numeric;begin
 select external_id into ext from signed_import_actor;
 rows:=jsonb_build_array(jsonb_build_object('row',2,'externalId',ext,'name','Synthetic signed subject','market','Synthetic signed market','fields',jsonb_build_object('units.actual',jsonb_build_object('kind','value','value',-3,'sourceColumn','E')),'normalized',jsonb_build_object('groupId','HE','month','2006-10','setting','full','phase','WEEKLY_PROGRESS','metrics',jsonb_build_array(jsonb_build_object('key','units','unit','Stück','actual',-3,'target',10)))));
 batch:=public.sec_stage_import('HE','2006-10-01','WEEKLY_PROGRESS','2006-10-15',md5(ext||'week')||md5(ext||'week'),'Synthetic rollback-only weekly','Test','[]',null,rows);
 again:=public.sec_stage_import('HE','2006-10-01','WEEKLY_PROGRESS','2006-10-15',md5(ext||'week')||md5(ext||'week'),'Synthetic rollback-only weekly','Test','[]',null,rows);
 if batch.id<>again.id then raise exception 'Draft idempotency changed';end if;
 perform public.sec_publish_import(batch.id);
 select (payload->'metrics'->0->>'actual')::numeric into actual from public.sec_weekly_snapshots where import_id=batch.id;
 if actual is distinct from -3 then raise exception 'Signed weekly value was changed';end if;
 if not exists(select 1 from public.sec_import_rows where import_id=batch.id and (fields->'units.actual'->>'value')::numeric=-3) then raise exception 'Raw signed cell lost';end if;
 rows:=jsonb_set(rows,'{0,normalized,metrics,0,actual}','-5');rows:=jsonb_set(rows,'{0,fields,units.actual,value}','-5');
 batch:=public.sec_stage_import('HE','2006-10-01','WEEKLY_PROGRESS','2006-10-15',md5(ext||'correction')||md5(ext||'correction'),'Synthetic rollback-only correction','Test','[]',null,rows);
 perform public.sec_publish_import(batch.id);
 select (payload->'metrics'->0->>'actual')::numeric into actual from public.sec_weekly_snapshots where person_id=(select id from public.sec_people where external_id=ext) order by revision desc limit 1;
 if actual is distinct from -5 then raise exception 'Signed correction was not the latest revision';end if;
 rows:=jsonb_set(rows,'{0,normalized,phase}','"MONTH_FINALIZATION"');rows:=jsonb_set(rows,'{0,normalized,metrics,0,achievement}','-35');rows:=jsonb_set(rows,'{0,normalized,premium}','-42.5');
 batch:=public.sec_stage_import('HE','2006-10-01','MONTH_FINALIZATION','2006-10-31',md5(ext||'closing')||md5(ext||'closing'),'Synthetic rollback-only historical closing','Test','[]',null,rows);
 perform public.sec_publish_import(batch.id);
 if not exists(select 1 from public.sec_monthly_reports where import_id=batch.id and (payload->'metrics'->0->>'achievement')::numeric=-35 and (payload->>'premium')::numeric=-42.5) then raise exception 'Historical signed closing value lost';end if;
end $$;
reset role;
rollback;
select 'Signed staging, idempotency, correction and historical publication checks passed; all fixtures rolled back.' as verification;
