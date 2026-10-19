-- Narrow wrappers: callers cannot choose an actor, bypass scope, update revisions, or promote themselves.
create or replace function sec_private.is_app_admin() returns boolean
 language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.sec_accounts where user_id=sec_private.actor_id()
 and role='app_admin' and not must_change_password)
$$;
create or replace function sec_private.department_scope() returns text[]
 language sql stable security definer set search_path='' as $$
 select coalesce((select case when role='app_admin' then array['HE','DA','IM','LH','ST']::text[]
 when role='department_admin' then department_ids else '{}'::text[] end
 from public.sec_accounts where user_id=sec_private.actor_id() and not must_change_password),'{}'::text[])
$$;
create or replace function sec_private.actor_person() returns uuid
 language sql stable security definer set search_path='' as $$
 select person_id from public.sec_accounts where user_id=sec_private.actor_id() and not must_change_password
$$;

create function sec_private.audit(p_department text,p_action text,p_kind text,p_id uuid,p_details jsonb default '{}') returns void
 language plpgsql security definer set search_path='' as $$
begin
 if sec_private.actor_id() is null then raise exception 'Unauthenticated' using errcode='42501'; end if;
 insert into public.sec_audit_events(actor_id,department_id,action,resource_type,resource_id,details)
 values(sec_private.actor_id(),p_department,p_action,p_kind,p_id,p_details);
end $$;

create function sec_private.manage_account(p_user_id uuid,p_profile jsonb) returns public.sec_accounts
 language plpgsql security definer set search_path='' as $$
declare old public.sec_accounts; result public.sec_accounts; allowed text[];
 requested_role text; departments text[]; requested_person uuid; is_root boolean;
begin
 allowed:=sec_private.department_scope(); is_root:=sec_private.is_app_admin();
 if sec_private.actor_id() is null or cardinality(allowed)=0 then raise exception 'Administrator access required' using errcode='42501'; end if;
 perform pg_advisory_xact_lock(hashtext('sec_account_management'));
 select * into old from public.sec_accounts where user_id=p_user_id for update;
 requested_role:=coalesce(p_profile->>'role',old.role,'sec');
 select coalesce(array_agg(value),'{}'::text[]) into departments from jsonb_array_elements_text(coalesce(p_profile->'department_ids',to_jsonb(old.department_ids),'[]'));
 if not is_root and (requested_role<>'sec' or old.role in ('app_admin','department_admin')
   or not departments <@ allowed or (old.user_id is not null and not old.department_ids <@ allowed))
 then raise exception 'Account outside department scope' using errcode='42501'; end if;
 requested_person:=case when p_profile ? 'person_id' then nullif(p_profile->>'person_id','')::uuid else old.person_id end;
 if requested_person is not null and not is_root and not exists(select 1 from public.sec_assignments where person_id=requested_person and department_id=any(allowed))
 then raise exception 'Person outside department scope' using errcode='42501'; end if;
 if old.role='app_admin' and old.active and
   (requested_role<>'app_admin' or p_profile->>'active'='false')
   and (select count(*) from public.sec_accounts where role='app_admin' and active)<=1
 then raise exception 'The last active app administrator must remain enabled'; end if;
 if old.user_id is null then
   insert into public.sec_accounts(user_id,email,display_name,role,department_ids,person_id,primary_department,setting,must_change_password,is_test)
   select u.id,u.email,coalesce(p_profile->>'display_name',''),requested_role,departments,requested_person,
    nullif(p_profile->>'primary_department',''),coalesce(p_profile->>'setting','full'),true,false
   from auth.users u where u.id=p_user_id and u.email_confirmed_at is not null
   returning * into result;
   if result.user_id is null then raise exception 'Verified Auth account not found'; end if;
 else
   update public.sec_accounts set display_name=coalesce(p_profile->>'display_name',display_name),
    role=requested_role,department_ids=departments,person_id=requested_person,
    primary_department=case when p_profile ? 'primary_department' then nullif(p_profile->>'primary_department','') else primary_department end,
    setting=coalesce(p_profile->>'setting',setting),
    active=coalesce((p_profile->>'active')::boolean,active),updated_at=now()
   where user_id=p_user_id returning * into result;
 end if;
 if not result.active then delete from auth.sessions where user_id=p_user_id; end if;
 perform sec_private.audit(case when is_root then null else departments[1] end,'account.updated','account',p_user_id,
   jsonb_build_object('role',result.role,'departments',result.department_ids,'active',result.active,'linked',result.person_id is not null));
 return result;
end $$;
create function public.sec_manage_account(p_user_id uuid,p_profile jsonb) returns public.sec_accounts
 language sql security invoker set search_path='' as $$ select sec_private.manage_account(p_user_id,p_profile) $$;

create function sec_private.save_config(p_department text,p_setting text,p_month date,p_definition jsonb,p_note text) returns public.sec_config_versions
 language plpgsql security definer set search_path='' as $$
declare result public.sec_config_versions; n integer;
begin
 if not p_department=any(sec_private.department_scope()) then raise exception 'Department not permitted' using errcode='42501'; end if;
 if jsonb_typeof(p_definition)<>'object' or jsonb_typeof(p_definition->'metrics')<>'array' then raise exception 'Invalid configuration'; end if;
 perform pg_advisory_xact_lock(hashtext('sec_config:'||p_department||':'||p_setting||':'||p_month::text));
 select coalesce(max(version),0)+1 into n from public.sec_config_versions where department_id=p_department and setting=p_setting and effective_month=p_month;
 insert into public.sec_config_versions(department_id,setting,effective_month,version,definition,note,created_by)
 values(p_department,p_setting,p_month,n,p_definition,coalesce(p_note,''),sec_private.actor_id()) returning * into result;
 perform sec_private.audit(p_department,'configuration.saved','configuration',result.id,jsonb_build_object('version',n));
 return result;
end $$;
create function public.sec_save_config(p_department text,p_setting text,p_month date,p_definition jsonb,p_note text default '') returns public.sec_config_versions
 language sql security invoker set search_path='' as $$ select sec_private.save_config(p_department,p_setting,p_month,p_definition,p_note) $$;

create function sec_private.stage_import(p_department text,p_month date,p_phase text,p_as_of date,p_fingerprint text,p_filename text,p_sheet text,p_mapping jsonb,p_config uuid,p_rows jsonb) returns public.sec_imports
 language plpgsql security definer set search_path='' as $$
declare result public.sec_imports; item jsonb; person uuid; assignment uuid; count_rows integer:=0;
 normalized jsonb; row_setting text; existing_name text; external_id text;
begin
 if not p_department=any(sec_private.department_scope()) then raise exception 'Department not permitted' using errcode='42501'; end if;
 if p_as_of > (now() at time zone 'Europe/Vienna')::date then raise exception 'Future stands cannot be staged'; end if;
 if jsonb_typeof(p_rows)<>'array' or jsonb_array_length(p_rows) not between 1 and 20000 then raise exception 'Invalid import rows'; end if;
 if p_config is not null and not exists(select 1 from public.sec_config_versions where id=p_config and department_id=p_department)
 then raise exception 'Configuration outside department'; end if;
 perform pg_advisory_xact_lock(hashtext('sec_import:'||p_department||':'||p_month::text));
 select * into result from public.sec_imports where department_id=p_department and month=p_month and phase=p_phase and fingerprint=p_fingerprint;
 if result.id is not null then return result; end if;
 insert into public.sec_imports(department_id,month,phase,as_of,fingerprint,filename,sheet,mapping,config_id,created_by)
 values(p_department,p_month,p_phase,p_as_of,p_fingerprint,p_filename,p_sheet,p_mapping,p_config,sec_private.actor_id()) returning * into result;
 for item in select value from jsonb_array_elements(p_rows)
 loop
   normalized:=item->'normalized'; row_setting:=coalesce(normalized->>'setting','full'); external_id:=btrim(item->>'externalId');
   if normalized->>'groupId' is distinct from p_department or normalized->>'month' is distinct from to_char(p_month,'YYYY-MM')
    or jsonb_typeof(normalized->'metrics')<>'array' or external_id is null or external_id=''
    or jsonb_typeof(item->'fields')<>'object'
   then raise exception 'Invalid normalized row or context'; end if;
   if (item->'fields') ?| array['premium.salary','assignment.comment','attendance.reason','attendance.code']
   then raise exception 'Unnecessary HR fields are not accepted'; end if;
   insert into public.sec_people(external_id,name) values(external_id,coalesce(item->>'name',''))
    on conflict (external_id) do nothing;
   select id,name into person,existing_name from public.sec_people where sec_people.external_id=stage_import.external_id;
   if existing_name<>coalesce(item->>'name','') and length(coalesce(item->>'name',''))>0 then
     if sec_private.is_app_admin() or exists(select 1 from public.sec_assignments where person_id=person and department_id=any(sec_private.department_scope()))
     then update public.sec_people set name=item->>'name' where id=person; end if;
   end if;
   insert into public.sec_assignments(person_id,department_id,setting,market,source_shop_id)
    values(person,p_department,row_setting,btrim(item->>'market'),nullif(item->>'sourceShopId',''))
    on conflict(person_id,department_id,setting,market) do nothing;
   select id into assignment from public.sec_assignments where person_id=person and department_id=p_department and setting=row_setting and market=btrim(item->>'market');
   insert into public.sec_import_rows(import_id,person_id,assignment_id,source_row,fields,normalized)
    values(result.id,person,assignment,(item->>'row')::integer,item->'fields',normalized);
   count_rows:=count_rows+1;
 end loop;
 update public.sec_imports set row_count=count_rows where id=result.id returning * into result;
 perform sec_private.audit(p_department,'import.staged','import',result.id,jsonb_build_object('phase',p_phase,'rows',count_rows));
 return result;
end $$;
create function public.sec_stage_import(p_department text,p_month date,p_phase text,p_as_of date,p_fingerprint text,p_filename text,p_sheet text,p_mapping jsonb,p_config uuid,p_rows jsonb) returns public.sec_imports
 language sql security invoker set search_path='' as $$ select sec_private.stage_import(p_department,p_month,p_phase,p_as_of,p_fingerprint,p_filename,p_sheet,p_mapping,p_config,p_rows) $$;

create function sec_private.publish_import(p_import uuid) returns public.sec_imports
 language plpgsql security definer set search_path='' as $$
declare batch public.sec_imports; r public.sec_import_rows; n integer;
begin
 select * into batch from public.sec_imports where id=p_import for update;
 if batch.id is null or not batch.department_id=any(sec_private.department_scope())
 then raise exception 'Import not permitted' using errcode='42501'; end if;
 if batch.status='published' then return batch; end if;
 if batch.status<>'draft' or batch.row_count=0 then raise exception 'Only a validated nonempty draft can be published'; end if;
 if batch.as_of > (now() at time zone 'Europe/Vienna')::date then raise exception 'Future publication not permitted'; end if;
 perform pg_advisory_xact_lock(hashtext('sec_publication:'||batch.department_id||':'||batch.month::text));
 for r in select * from public.sec_import_rows where import_id=p_import
 loop
   if batch.phase='MONTH_FINALIZATION' then
    select coalesce(max(revision),0)+1 into n from public.sec_monthly_reports where person_id=r.person_id and assignment_id=r.assignment_id and month=batch.month;
    insert into public.sec_monthly_reports(person_id,assignment_id,department_id,month,revision,import_id,configuration_id,payload)
     values(r.person_id,r.assignment_id,batch.department_id,batch.month,n,p_import,batch.config_id,r.normalized);
   else
    select coalesce(max(revision),0)+1 into n from public.sec_weekly_snapshots where person_id=r.person_id and assignment_id=r.assignment_id and month=batch.month and as_of=batch.as_of;
    insert into public.sec_weekly_snapshots(person_id,assignment_id,department_id,month,as_of,revision,import_id,payload)
     values(r.person_id,r.assignment_id,batch.department_id,batch.month,batch.as_of,n,p_import,r.normalized);
   end if;
 end loop;
 update public.sec_imports set status='published',published_at=now(),published_by=sec_private.actor_id() where id=p_import returning * into batch;
 perform sec_private.audit(batch.department_id,'import.published','import',p_import,jsonb_build_object('phase',batch.phase,'rows',batch.row_count));
 return batch;
end $$;
create function public.sec_publish_import(p_import uuid) returns public.sec_imports
 language sql security invoker set search_path='' as $$ select sec_private.publish_import(p_import) $$;

create function sec_private.resolve_privacy(p_request uuid,p_status text,p_response text,p_identity_checked boolean) returns public.sec_privacy_requests
 language plpgsql security definer set search_path='' as $$
declare result public.sec_privacy_requests;
begin
 select * into result from public.sec_privacy_requests where id=p_request for update;
 if result.id is null or not (sec_private.is_app_admin() or result.department_id=any(sec_private.department_scope()))
 then raise exception 'Request not permitted' using errcode='42501'; end if;
 if p_status in ('fulfilled','declined') and not (p_identity_checked or result.identity_checked_at is not null)
 then raise exception 'Identity verification is required before completion'; end if;
 update public.sec_privacy_requests set status=p_status,response=p_response,handled_by=sec_private.actor_id(),
 identity_checked_at=case when p_identity_checked then coalesce(identity_checked_at,now()) else identity_checked_at end,
 completed_at=case when p_status in ('fulfilled','declined') then now() else null end
 where id=p_request returning * into result;
 perform sec_private.audit(result.department_id,'privacy.request.updated','privacy_request',p_request,jsonb_build_object('status',p_status));
 return result;
end $$;
create function public.sec_resolve_privacy(p_request uuid,p_status text,p_response text,p_identity_checked boolean default false) returns public.sec_privacy_requests
 language sql security invoker set search_path='' as $$ select sec_private.resolve_privacy(p_request,p_status,p_response,p_identity_checked) $$;

create function sec_private.ack_notice(p_version text) returns void
 language plpgsql security definer set search_path='' as $$
begin
 if sec_private.actor_id() is null then raise exception 'Unauthenticated' using errcode='42501'; end if;
 if p_version<>(select notice_version from public.sec_security_settings where singleton) then raise exception 'Current notice version required'; end if;
 update public.sec_accounts set notice_version=p_version,notice_acknowledged_at=now(),updated_at=now() where user_id=sec_private.actor_id();
 perform sec_private.audit(null,'notice.acknowledged','account',sec_private.actor_id(),jsonb_build_object('version',p_version));
end $$;
create function public.sec_ack_notice(p_version text) returns void
 language sql security invoker set search_path='' as $$ select sec_private.ack_notice(p_version) $$;

revoke all on all functions in schema sec_private from public,anon,authenticated,service_role;
grant execute on all functions in schema sec_private to authenticated;
revoke execute on function sec_private.audit(text,text,text,uuid,jsonb) from authenticated;
revoke all on function public.sec_manage_account(uuid,jsonb),public.sec_save_config(text,text,date,jsonb,text),
 public.sec_stage_import(text,date,text,date,text,text,text,jsonb,uuid,jsonb),public.sec_publish_import(uuid),
 public.sec_resolve_privacy(uuid,text,text,boolean),public.sec_ack_notice(text)
 from public,anon,service_role;
grant execute on function public.sec_manage_account(uuid,jsonb),public.sec_save_config(text,text,date,jsonb,text),
 public.sec_stage_import(text,date,text,date,text,text,text,jsonb,uuid,jsonb),public.sec_publish_import(uuid),
 public.sec_resolve_privacy(uuid,text,text,boolean),public.sec_ack_notice(text) to authenticated;

