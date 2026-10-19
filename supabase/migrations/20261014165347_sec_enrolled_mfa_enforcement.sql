create or replace function sec_private.actor_id() returns uuid
 language sql stable security definer set search_path='' as $$
 select a.user_id from public.sec_accounts a
 where a.user_id=(select auth.uid()) and a.active
 and exists(select 1 from auth.sessions s where s.id=nullif((select auth.jwt())->>'session_id','')::uuid and s.user_id=a.user_id)
 and ((select auth.jwt())->>'aal'='aal2' or (
   not exists(select 1 from auth.mfa_factors f where f.user_id=a.user_id and f.status='verified')
   and (a.role='sec' or not (select require_admin_mfa from public.sec_security_settings where singleton))
 ))
$$;
create or replace function sec_private.auth_status() returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('mfaRequired',
  ((a.role<>'sec' and s.require_admin_mfa) or exists(select 1 from auth.mfa_factors f where f.user_id=a.user_id and f.status='verified'))
  and coalesce((select auth.jwt())->>'aal','aal1')<>'aal2','noticeVersion',s.notice_version)
 from public.sec_accounts a cross join public.sec_security_settings s where a.user_id=sec_private.session_actor_id()
$$;
