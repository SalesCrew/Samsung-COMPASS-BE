-- Supervisors inspect the existing SEC dashboard; they never become an employee
-- or an administrator. Existing table RLS and write permissions stay in force.
alter table public.sec_accounts drop constraint sec_accounts_role_check;
alter table public.sec_accounts add constraint sec_accounts_role_check
 check(role in ('app_admin','department_admin','sec','supervisor'));
alter table public.sec_accounts drop constraint sec_accounts_check;
alter table public.sec_accounts add constraint sec_accounts_check
 check(role in ('app_admin','supervisor') or cardinality(department_ids)>0);
alter table public.sec_accounts add constraint sec_supervisor_unlinked
 check(role<>'supervisor' or (person_id is null and primary_department is null
  and cardinality(department_ids)=0 and setting='full'));

-- Optional enrolled MFA still applies to every role. The administrator-only
-- enrollment requirement does not turn a read-only supervisor into an admin.
create or replace function sec_private.actor_id() returns uuid
language sql stable security definer set search_path='' as $$
 select a.user_id from public.sec_accounts a
 where a.user_id=(select auth.uid()) and a.active
 and exists(select 1 from auth.sessions s where s.id=nullif((select auth.jwt())->>'session_id','')::uuid and s.user_id=a.user_id)
 and ((select auth.jwt())->>'aal'='aal2' or (
  not exists(select 1 from auth.mfa_factors f where f.user_id=a.user_id and f.status='verified')
  and (a.role in ('sec','supervisor') or not (select require_admin_mfa from public.sec_security_settings where singleton))
 ))
$$;
create or replace function sec_private.auth_status() returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object('mfaRequired',
  ((a.role in ('app_admin','department_admin') and s.require_admin_mfa)
   or exists(select 1 from auth.mfa_factors f where f.user_id=a.user_id and f.status='verified'))
  and coalesce((select auth.jwt())->>'aal','aal1')<>'aal2','noticeVersion',s.notice_version)
 from public.sec_accounts a cross join public.sec_security_settings s where a.user_id=sec_private.session_actor_id()
$$;

create function sec_private.is_supervisor() returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.sec_accounts a
  where a.user_id=sec_private.actor_id() and a.role='supervisor' and not a.must_change_password)
$$;

-- Minimal, named directory of active real SEC accounts in their assigned division
-- and DA setting. No Auth IDs/emails, test identities or import/staging records.
create function sec_private.supervisor_directory() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
 if not sec_private.is_supervisor() then raise exception 'Supervisor access required' using errcode='42501'; end if;
 select coalesce(jsonb_agg(jsonb_build_object(
  'assignment_id',s.id,'person_id',s.person_id,'name',coalesce(nullif(btrim(u.display_name),''),nullif(btrim(p.name),''),'SEC ohne Namen'),
  'department_id',s.department_id,'setting',s.setting,'market',s.market
 ) order by s.department_id,lower(coalesce(nullif(btrim(u.display_name),''),p.name)),s.market,s.id),'[]'::jsonb)
 into result from public.sec_accounts u join public.sec_people p on p.id=u.person_id
 join public.sec_assignments s on s.person_id=u.person_id and s.department_id=u.primary_department
  and (s.department_id<>'DA' or s.setting=u.setting)
 where u.role='sec' and u.active and not u.is_test;
 return result;
end $$;
create function public.sec_supervisor_directory() returns jsonb
language sql stable security invoker set search_path='' as $$ select sec_private.supervisor_directory() $$;

-- Single authorization rule for both normal own history and supervisor reads.
-- No impersonated JWT, selected-subject session, broad read policy or server key.
create function sec_private.dashboard_assignment(p_assignment uuid) returns public.sec_assignments
language plpgsql stable security definer set search_path='' as $$
declare result public.sec_assignments;
begin
 if sec_private.is_supervisor() then
  select s.* into result from public.sec_assignments s join public.sec_accounts u
   on u.person_id=s.person_id and u.primary_department=s.department_id
   and (s.department_id<>'DA' or u.setting=s.setting)
  where s.id=p_assignment and u.role='sec' and u.active and not u.is_test;
 else
  select s.* into result from public.sec_assignments s join public.sec_accounts u on u.user_id=sec_private.actor_id()
  where s.id=p_assignment and s.person_id=sec_private.actor_person()
   and s.department_id=u.primary_department and (s.department_id<>'DA' or s.setting=u.setting);
 end if;
 if result.id is null then raise exception 'SEC assignment not permitted' using errcode='42501'; end if;
 return result;
end $$;

create function sec_private.supervisor_dashboard(p_assignment uuid default null) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare a public.sec_assignments; u public.sec_accounts; reports jsonb; weekly jsonb; assignments jsonb; premium_rows jsonb; receipts jsonb; rankings jsonb;
begin
 if not sec_private.is_supervisor() then raise exception 'Supervisor access required' using errcode='42501'; end if;
 if p_assignment is null then
  p_assignment:=(sec_private.supervisor_directory()->0->>'assignment_id')::uuid;
  if p_assignment is null then
   return jsonb_build_object('subject',null,'assignments','[]'::jsonb,'reports','[]'::jsonb,'weekly','[]'::jsonb,
    'premiumRows','[]'::jsonb,'pointHistory','[]'::jsonb,'read','[]'::jsonb,'rankings','{}'::jsonb);
  end if;
 end if;
 a:=sec_private.dashboard_assignment(p_assignment);
 select * into strict u from public.sec_accounts c where c.person_id=a.person_id and c.role='sec' and c.active and not c.is_test;
 select coalesce(jsonb_agg(to_jsonb(s) order by s.created_at,s.id),'[]'::jsonb) into assignments
 from public.sec_assignments s where s.person_id=a.person_id and s.department_id=u.primary_department and (s.department_id<>'DA' or s.setting=u.setting);
 select coalesce(jsonb_agg(to_jsonb(r) order by r.published_at,r.id),'[]'::jsonb) into reports
 from public.sec_monthly_reports r where r.assignment_id=a.id;
 select coalesce(jsonb_agg(to_jsonb(w) order by w.published_at,w.id),'[]'::jsonb) into weekly
 from public.sec_weekly_snapshots w where w.assignment_id=a.id;
 -- Project only fields consumed by the shared premium aggregation.
 select coalesce(jsonb_agg(jsonb_build_object('id',r.id,'person_id',r.person_id,'department_id',r.department_id,
  'assignment_id',r.assignment_id,'month',r.month,'revision',r.revision,
  'payload',jsonb_build_object('premium',r.payload->'premium','extras',r.payload->'extras','extrasAvailable',r.payload->'extrasAvailable'))),'[]'::jsonb)
 into premium_rows from public.sec_monthly_reports r where r.person_id=a.person_id and r.department_id=a.department_id;
 select coalesce(jsonb_agg(jsonb_build_object('report_id',r.report_id)),'[]'::jsonb) into receipts
 from public.sec_read_receipts r join public.sec_monthly_reports m on m.id=r.report_id
 where r.user_id=u.user_id and m.assignment_id=a.id;
 select coalesce(jsonb_object_agg(to_char(m.month,'YYYY-MM'),sec_private.own_rank(a.id,m.month)),'{}'::jsonb) into rankings
 from (select distinct r.month from public.sec_monthly_reports r where r.assignment_id=a.id) m;
 return jsonb_build_object('subject',jsonb_build_object('person_id',a.person_id,'display_name',coalesce(nullif(btrim(u.display_name),''),(select p.name from public.sec_people p where p.id=a.person_id)),
  'primary_department',u.primary_department,'setting',u.setting),'assignments',assignments,'selectedAssignment',a.id,
  'reports',reports,'weekly',weekly,'pointHistory',sec_private.own_point_history(a.id),'premiumRows',premium_rows,'read',receipts,'rankings',rankings);
end $$;
create function public.sec_supervisor_dashboard(p_assignment uuid default null) returns jsonb
language sql stable security invoker set search_path='' as $$ select sec_private.supervisor_dashboard(p_assignment) $$;

revoke all on function sec_private.is_supervisor(),sec_private.dashboard_assignment(uuid),
 sec_private.supervisor_directory(),public.sec_supervisor_directory(),
 sec_private.supervisor_dashboard(uuid),public.sec_supervisor_dashboard(uuid) from public,anon,authenticated,service_role;
grant execute on function sec_private.is_supervisor(),sec_private.dashboard_assignment(uuid),
 sec_private.supervisor_directory(),public.sec_supervisor_directory(),
 sec_private.supervisor_dashboard(uuid),public.sec_supervisor_dashboard(uuid) to authenticated;

-- Reuse the established point/rank calculation after the explicit subject guard.
create or replace function sec_private.own_point_history(p_assignment uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare a public.sec_assignments; result jsonb;
begin
 a:=sec_private.dashboard_assignment(p_assignment);
 if a.department_id='ST' then return '[]'::jsonb; end if;
 select coalesce(jsonb_agg(jsonb_build_object('month',to_char(h.month,'YYYY-MM'),'points',h.points,'sourceLevel',h.source_level) order by h.month),'[]'::jsonb)
 into result from sec_private.monthly_point_history(a.department_id,'0001-01-01',date_trunc('month',current_date)::date,a.person_id) h;
 return result;
end $$;
create or replace function public.sec_own_point_history(p_assignment uuid) returns jsonb
language sql stable security invoker set search_path='' as $$ select sec_private.own_point_history(p_assignment) $$;
revoke all on function sec_private.own_point_history(uuid),public.sec_own_point_history(uuid) from public,anon,authenticated,service_role;
grant execute on function sec_private.own_point_history(uuid),public.sec_own_point_history(uuid) to authenticated;

create or replace function sec_private.own_rank(p_assignment uuid,p_month date) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare a public.sec_assignments; pool integer; own_points numeric; place integer;
begin
 a:=sec_private.dashboard_assignment(p_assignment);
 if a.department_id='ST' or p_month is null or extract(day from p_month)<>1
  or p_month>date_trunc('month',current_date)::date then
  return jsonb_build_object('pool',0,'rank',null,'outsideTopTen',false,'reason','unavailable');
 end if;
 with totals as (
  select h.person_id,sum(h.points) as points
  from sec_private.monthly_point_history(a.department_id,(p_month-interval '11 months')::date,p_month) h
  group by h.person_id having count(*)=12 and count(h.points)=12
 )
 select count(*),max(t.points) filter(where t.person_id=a.person_id),
  (1+count(*) filter(where t.points>(select own.points from totals own where own.person_id=a.person_id)))::integer
 into pool,own_points,place from totals t;
 if own_points is null then return jsonb_build_object('pool',0,'rank',null,'outsideTopTen',false,'reason','incomplete-history'); end if;
 if pool<10 then return jsonb_build_object('pool',0,'rank',null,'outsideTopTen',false,'reason','not-enough-participants'); end if;
 return jsonb_build_object('pool',pool,'rank',case when place<=10 then place else null end,'outsideTopTen',place>10);
end $$;
revoke all on function sec_private.own_rank(uuid,date),public.sec_own_rank(uuid,date) from public,anon,authenticated,service_role;
grant execute on function sec_private.own_rank(uuid,date),public.sec_own_rank(uuid,date) to authenticated;


-- Only root administrators can manage supervisor access.
create or replace function sec_private.manage_account(p_user_id uuid,p_profile jsonb) returns public.sec_accounts
 language plpgsql security definer set search_path='' as $$
declare old public.sec_accounts; result public.sec_accounts; allowed text[];
 requested_role text; departments text[]; requested_person uuid; is_root boolean; next_department text; next_setting text;
begin
 allowed:=sec_private.department_scope(); is_root:=sec_private.is_app_admin();
 if sec_private.actor_id() is null or cardinality(allowed)=0 then raise exception 'Administrator access required' using errcode='42501'; end if;
 perform pg_advisory_xact_lock(hashtext('sec_account_management'));
 select * into old from public.sec_accounts where user_id=p_user_id for update;
 requested_role:=coalesce(p_profile->>'role',old.role,'sec');
 select coalesce(array_agg(value),'{}'::text[]) into departments from jsonb_array_elements_text(coalesce(p_profile->'department_ids',to_jsonb(old.department_ids),'[]'));
 if not is_root and (requested_role<>'sec' or old.role in ('app_admin','department_admin','supervisor')
   or not departments <@ allowed or (old.user_id is not null and not old.department_ids <@ allowed))
 then raise exception 'Account outside department scope' using errcode='42501'; end if;
 next_department:=case when p_profile ? 'primary_department' then nullif(p_profile->>'primary_department','') else old.primary_department end;
 next_setting:=case when next_department='DA' then coalesce(p_profile->>'setting',old.setting,'full') else 'full' end;
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
    next_department,next_setting,true,false
   from auth.users u where u.id=p_user_id and u.email_confirmed_at is not null
   returning * into result;
   if result.user_id is null then raise exception 'Verified Auth account not found'; end if;
 else
   update public.sec_accounts set display_name=coalesce(p_profile->>'display_name',display_name),
    role=requested_role,department_ids=departments,person_id=requested_person,
    primary_department=next_department,
    setting=next_setting,
    active=coalesce((p_profile->>'active')::boolean,active),updated_at=now()
   where user_id=p_user_id returning * into result;
 end if;
 if not result.active then delete from auth.sessions where user_id=p_user_id; end if;
 perform sec_private.audit(case when is_root then null else departments[1] end,'account.updated','account',p_user_id,
   jsonb_build_object('role',result.role,'departments',result.department_ids,'active',result.active,'linked',result.person_id is not null));
 return result;
end $$;


notify pgrst,'reload schema';
