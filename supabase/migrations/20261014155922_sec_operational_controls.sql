-- Date-accurate configuration versions; month remains the period of the imported data.
alter table public.sec_config_versions drop constraint sec_config_versions_effective_month_check;
alter table public.sec_config_versions rename column effective_month to effective_from;
create or replace function sec_private.save_config(p_department text,p_setting text,p_month date,p_definition jsonb,p_note text) returns public.sec_config_versions
 language plpgsql security definer set search_path='' as $$
declare result public.sec_config_versions; n integer;
begin
 if auth.uid() is null or not p_department=any(sec_private.department_scope()) then raise exception 'Department not permitted' using errcode='42501'; end if;
 if p_month is null or jsonb_typeof(p_definition->'metrics') is distinct from 'array' or jsonb_array_length(p_definition->'metrics') not between 1 and 100 then raise exception 'Invalid configuration'; end if;
 perform pg_advisory_xact_lock(hashtext('sec_config:'||p_department||':'||p_setting||':'||p_month::text));
 select coalesce(max(version),0)+1 into n from public.sec_config_versions where department_id=p_department and setting=p_setting and effective_from=p_month;
 insert into public.sec_config_versions(department_id,setting,effective_from,version,definition,note,created_by)
 values(p_department,p_setting,p_month,n,p_definition,coalesce(p_note,''),sec_private.actor_id()) returning * into result;
 perform sec_private.audit(p_department,'configuration.saved','configuration',result.id,jsonb_build_object('version',n));
 return result;
end $$;
create unique index sec_active_person_account_idx on public.sec_accounts(person_id) where active and role='sec' and person_id is not null;
alter table public.sec_retention_policies add column legal_basis text;
create function sec_private.session_actor_id() returns uuid language sql stable security definer set search_path='' as $$
 select a.user_id from public.sec_accounts a where a.user_id=(select auth.uid()) and a.active
 and exists(select 1 from auth.sessions s where s.id=nullif((select auth.jwt())->>'session_id','')::uuid and s.user_id=a.user_id)
$$;
revoke all on function sec_private.session_actor_id() from public,anon;
grant execute on function sec_private.session_actor_id() to authenticated;
alter policy sec_account_read on public.sec_accounts using(user_id=(select sec_private.session_actor_id()) or (select sec_private.is_app_admin()) or (role='sec' and department_ids && (select sec_private.department_scope())));
create function sec_private.auth_status() returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('mfaRequired',a.role<>'sec' and s.require_admin_mfa and coalesce((select auth.jwt())->>'aal','aal1')<>'aal2','noticeVersion',s.notice_version)
 from public.sec_accounts a cross join public.sec_security_settings s where a.user_id=sec_private.session_actor_id()
$$;
create function public.sec_auth_status() returns jsonb language sql security invoker set search_path='' as $$ select sec_private.auth_status() $$;
create function sec_private.set_security(p_require_mfa boolean) returns void language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is null or not sec_private.is_app_admin() or (select auth.jwt())->>'aal' is distinct from 'aal2' then raise exception 'App admin and verified MFA required' using errcode='42501'; end if;
 update public.sec_security_settings set require_admin_mfa=p_require_mfa where singleton;
 perform sec_private.audit(null,'security.updated','settings',null,jsonb_build_object('require_admin_mfa',p_require_mfa));
end $$;
create function public.sec_set_security(p_require_mfa boolean) returns void language sql security invoker set search_path='' as $$ select sec_private.set_security(p_require_mfa) $$;
create function sec_private.reset_access(p_user uuid) returns void language plpgsql security definer set search_path='' as $$
declare a public.sec_accounts;
begin
 select * into a from public.sec_accounts where user_id=p_user for update;
 if auth.uid() is null or sec_private.actor_id() is null or a.user_id is null
 or (not sec_private.is_app_admin() and (a.role<>'sec' or not a.department_ids <@ sec_private.department_scope())) then raise exception 'Account not permitted' using errcode='42501'; end if;
 update public.sec_accounts set must_change_password=true,updated_at=now() where user_id=p_user;
 delete from auth.sessions where user_id=p_user;
 perform sec_private.audit(case when sec_private.is_app_admin() then null else a.primary_department end,'account.password_reset','account',p_user,'{}');
end $$;
create function public.sec_reset_access(p_user uuid) returns void language sql security invoker set search_path='' as $$ select sec_private.reset_access(p_user) $$;
create function sec_private.retention_policy(p_category text,p_months integer,p_basis text) returns void language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is null or not sec_private.is_app_admin() then raise exception 'App administrator required' using errcode='42501'; end if;
 if p_months not between 1 and 120 or length(btrim(p_basis)) not between 10 and 2000 then raise exception 'Period and documented basis required'; end if;
 update public.sec_retention_policies set months=p_months,approved=true,legal_basis=p_basis,approved_by=sec_private.actor_id(),approved_at=now() where category=p_category;
 if not found then raise exception 'Unknown category'; end if;
 perform sec_private.audit(null,'retention.approved','retention',null,jsonb_build_object('category',p_category,'months',p_months));
end $$;
create function public.sec_retention_policy(p_category text,p_months integer,p_basis text) returns void language sql security invoker set search_path='' as $$ select sec_private.retention_policy(p_category,p_months,p_basis) $$;
create function sec_private.legal_hold(p_person uuid,p_department text,p_reason text,p_release uuid default null) returns void language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is null or not sec_private.is_app_admin() then raise exception 'App administrator required' using errcode='42501'; end if;
 if p_release is not null then update public.sec_legal_holds set released_at=now() where id=p_release and released_at is null;
 else
  if length(btrim(p_reason)) not between 10 and 1000 then raise exception 'Reason required'; end if;
  insert into public.sec_legal_holds(person_id,department_id,reason,created_by) values(p_person,p_department,p_reason,sec_private.actor_id());
 end if;
 perform sec_private.audit(null,'legal_hold.updated','hold',p_release,'{}');
end $$;
create function public.sec_legal_hold(p_person uuid,p_department text,p_reason text,p_release uuid default null) returns void language sql security invoker set search_path='' as $$ select sec_private.legal_hold(p_person,p_department,p_reason,p_release) $$;
create function sec_private.reject_import(p_import uuid) returns void language plpgsql security definer set search_path='' as $$
declare d text;
begin
 select department_id into d from public.sec_imports where id=p_import and status='draft' for update;
 if auth.uid() is null or not coalesce(d=any(sec_private.department_scope()),false) then raise exception 'Draft not permitted' using errcode='42501'; end if;
 update public.sec_imports set status='rejected' where id=p_import;
 perform sec_private.audit(d,'import.rejected','import',p_import,'{}');
end $$;
create function public.sec_reject_import(p_import uuid) returns void language sql security invoker set search_path='' as $$ select sec_private.reject_import(p_import) $$;
revoke all on function sec_private.auth_status(),sec_private.set_security(boolean),sec_private.reset_access(uuid),sec_private.retention_policy(text,integer,text),sec_private.legal_hold(uuid,text,text,uuid),sec_private.reject_import(uuid) from public,anon;
revoke all on function public.sec_auth_status(),public.sec_set_security(boolean),public.sec_reset_access(uuid),public.sec_retention_policy(text,integer,text),public.sec_legal_hold(uuid,text,text,uuid),public.sec_reject_import(uuid) from public,anon;
grant execute on function sec_private.auth_status(),sec_private.set_security(boolean),sec_private.reset_access(uuid),sec_private.retention_policy(text,integer,text),sec_private.legal_hold(uuid,text,text,uuid),sec_private.reject_import(uuid) to authenticated;
grant execute on function public.sec_auth_status(),public.sec_set_security(boolean),public.sec_reset_access(uuid),public.sec_retention_policy(text,integer,text),public.sec_legal_hold(uuid,text,text,uuid),public.sec_reject_import(uuid) to authenticated;

