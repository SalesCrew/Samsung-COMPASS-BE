do $guard$ begin
 if not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='sec_private' and p.proname='dashboard_assignment' and md5(regexp_replace(p.prosrc,'\s','','g'))='97149b91c1ba2c865560a0d79e0d383b') then raise exception 'Function changed: dashboard_assignment';end if;
 if not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='sec_private' and p.proname='monthly_point_history' and md5(regexp_replace(p.prosrc,'\s','','g'))='72cd0742f61dc3eeabb85b49160df8b8') then raise exception 'Function changed: monthly_point_history';end if;
 if not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='sec_private' and p.proname='supervisor_dashboard' and md5(regexp_replace(p.prosrc,'\s','','g'))='b28d116fb31bd57c8aae4884c2e528a0') then raise exception 'Function changed: supervisor_dashboard';end if;
 if not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='sec_private' and p.proname='supervisor_directory' and md5(regexp_replace(p.prosrc,'\s','','g'))='3b66fd74f601e1d83852ddf9099dbea1') then raise exception 'Function changed: supervisor_directory';end if;
 if not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='sec_private' and p.proname='supervisor_group_source' and md5(regexp_replace(p.prosrc,'\s','','g'))='c65f1f09c25ddaef2aad7f7271e26f76') then raise exception 'Function changed: supervisor_group_source';end if;
 if not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='sec_private' and p.proname='record_historical_points' and md5(regexp_replace(p.prosrc,'\s','','g'))='d4cc5a773024ff2414f24bbec5b9d1fd') then raise exception 'Function changed: record_historical_points';end if;
 if not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='sec_private' and p.proname='own_point_evidence' and md5(regexp_replace(p.prosrc,'\s','','g'))='4a8d9a8c49738630fd21b17c24e56858') then raise exception 'Function changed: own_point_evidence';end if;
end $guard$;
-- Reversible assignment archives preserve every original published revision.
alter table public.sec_assignments add column archived_at timestamptz,add column archived_by uuid references auth.users(id) on delete set null,add column archive_reason text;
alter table public.sec_assignments add constraint sec_assignment_archive_reason check(archived_at is null or length(btrim(archive_reason)) between 1 and 1000);
alter table sec_private.historical_point_evidence add column source_locator jsonb not null default '{}'::jsonb check(jsonb_typeof(source_locator)='object');

-- User-confirmed former divisions describe the badge, separately from source values.
create table sec_private.person_division_history(
 id uuid primary key default gen_random_uuid(),person_id uuid not null references public.sec_people(id),department_id text not null references public.sec_departments(id),
 from_month date not null check(extract(day from from_month)=1),through_month date not null check(extract(day from through_month)=1 and through_month>=from_month),
 note text not null check(length(btrim(note)) between 1 and 1000),confirmed_by uuid references auth.users(id) on delete set null,created_at timestamptz not null default now(),
 unique(person_id,from_month,through_month)
);
alter table sec_private.person_division_history enable row level security;
alter table sec_private.person_division_history force row level security;
revoke all on sec_private.person_division_history from public,anon,authenticated,service_role;

create function sec_private.set_assignment_archived(p_assignment uuid,p_archived boolean,p_reason text) returns public.sec_assignments
language plpgsql security definer set search_path='' as $$
declare target public.sec_assignments;
begin
 if not sec_private.is_app_admin() then raise exception 'App administrator required' using errcode='42501';end if;
 if p_archived is null or p_assignment is null or p_reason is null or length(btrim(p_reason)) not between 1 and 1000 then raise exception 'Assignment, state and reason required' using errcode='22023';end if;
 select * into target from public.sec_assignments where id=p_assignment for update;
 if not found then raise exception 'Assignment not found' using errcode='22023';end if;
 if (target.archived_at is not null)=p_archived then return target;end if;
 update public.sec_assignments set archived_at=case when p_archived then now() else null end,archived_by=sec_private.actor_id(),archive_reason=btrim(p_reason) where id=target.id returning * into target;
 perform sec_private.audit(target.department_id,case when p_archived then 'assignment.archived' else 'assignment.restored' end,'assignment',target.id,jsonb_build_object('reason',btrim(p_reason)));
 return target;
end $$;
create function public.sec_set_assignment_archived(p_assignment uuid,p_archived boolean,p_reason text) returns public.sec_assignments
language sql security invoker set search_path='' as $$select sec_private.set_assignment_archived(p_assignment,p_archived,p_reason)$$;
revoke all on function sec_private.set_assignment_archived(uuid,boolean,text),public.sec_set_assignment_archived(uuid,boolean,text) from public,anon,authenticated,service_role;
grant execute on function sec_private.set_assignment_archived(uuid,boolean,text),public.sec_set_assignment_archived(uuid,boolean,text) to authenticated;

create function sec_private.confirm_division_history(p_person uuid,p_department text,p_from date,p_through date,p_note text) returns uuid
language plpgsql security definer set search_path='' as $$
declare existing sec_private.person_division_history;result uuid;
begin
 if not sec_private.is_app_admin() then raise exception 'App administrator required' using errcode='42501';end if;
 if p_person is null or not exists(select 1 from public.sec_people where id=p_person) or p_department is null or not exists(select 1 from public.sec_departments where id=p_department)
  or p_from is null or p_through is null or extract(day from p_from)<>1 or extract(day from p_through)<>1 or p_through<p_from or p_through>date_trunc('month',current_date)::date
  or p_note is null or length(btrim(p_note)) not between 1 and 1000 then raise exception 'Invalid confirmed division history' using errcode='22023';end if;
 perform pg_advisory_xact_lock(hashtext('sec_division_history:'||p_person::text));
 select * into existing from sec_private.person_division_history where person_id=p_person and from_month<=p_through and through_month>=p_from;
 if found then
  if existing.department_id=p_department and existing.from_month=p_from and existing.through_month=p_through and existing.note=btrim(p_note) then return existing.id;end if;
  raise exception 'Overlapping division history requires review' using errcode='22023';
 end if;
 insert into sec_private.person_division_history(person_id,department_id,from_month,through_month,note,confirmed_by) values(p_person,p_department,p_from,p_through,btrim(p_note),sec_private.actor_id()) returning id into result;
 perform sec_private.audit(null,'history.division_confirmed','person',p_person,jsonb_build_object('department',p_department,'from',p_from,'through',p_through));return result;
end $$;
create function public.sec_confirm_division_history(p_person uuid,p_department text,p_from date,p_through date,p_note text) returns uuid
language sql security invoker set search_path='' as $$select sec_private.confirm_division_history(p_person,p_department,p_from,p_through,p_note)$$;
revoke all on function sec_private.confirm_division_history(uuid,text,date,date,text),public.sec_confirm_division_history(uuid,text,date,date,text) from public,anon,authenticated,service_role;
grant execute on function sec_private.confirm_division_history(uuid,text,date,date,text),public.sec_confirm_division_history(uuid,text,date,date,text) to authenticated;

create or replace function sec_private.dashboard_assignment(p_assignment uuid) returns public.sec_assignments
language plpgsql stable security definer set search_path='' as $$
declare result public.sec_assignments;
begin
 if sec_private.is_supervisor() then
  select s.* into result from public.sec_assignments s join public.sec_accounts u
   on u.person_id=s.person_id and u.primary_department=s.department_id
   and (s.department_id<>'DA' or u.setting=s.setting)
  where s.id=p_assignment and s.archived_at is null and u.role='sec' and u.active and not u.is_test;
 else
  select s.* into result from public.sec_assignments s join public.sec_accounts u on u.user_id=sec_private.actor_id()
  where s.id=p_assignment and s.archived_at is null and s.person_id=sec_private.actor_person()
   and s.department_id=u.primary_department and (s.department_id<>'DA' or s.setting=u.setting);
 end if;
 if result.id is null then raise exception 'SEC assignment not permitted' using errcode='42501'; end if;
 return result;
end $$;
create or replace function sec_private.monthly_point_history(p_department text,p_from date,p_through date,p_person uuid default null)
returns table(person_id uuid,month date,points numeric,source_level text)
language sql stable security invoker set search_path='' as $$
 with active as (
  select distinct on(r.person_id,r.assignment_id,r.month) r.person_id,r.month,r.payload
  from public.sec_monthly_reports r join public.sec_assignments scope_assignment on scope_assignment.id=r.assignment_id and scope_assignment.archived_at is null
  where r.department_id=p_department and r.month between p_from and p_through and(p_person is null or r.person_id=p_person)
  order by r.person_id,r.assignment_id,r.month,r.revision desc
 ),typed as (
  select a.person_id,a.month,
   case when jsonb_typeof(a.payload->'points')='number' then case when(a.payload->>'points')::numeric between 0 and 3 then(a.payload->>'points')::numeric end end as value,
   case upper(regexp_replace(coalesce(a.payload->>'sourceLevel',''),'\s','','g')) when 'SEC' then 'SEC' when 'SEC+' then 'SEC+' when 'SECPRO' then 'SEC Pro' end as level
  from active a
 ), evidence as (
  select e.person_id,e.month,e.points::numeric as value,null::text as level from sec_private.historical_point_evidence e
  where e.department_id=p_department and e.month between p_from and p_through and(p_person is null or e.person_id=p_person)
   and not exists(select 1 from active a where a.person_id=e.person_id and a.month=e.month)
 ),combined as(select * from typed union all select * from evidence)
 select t.person_id,t.month,
  case when count(t.value)=count(*) and min(t.value)=max(t.value) then max(t.value) end,
  case when count(distinct t.level)=1 then max(t.level) end
 from combined t group by t.person_id,t.month
$$;
create function sec_private.own_level_history(p_assignment uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare a public.sec_assignments;result jsonb;
begin
 a:=sec_private.dashboard_assignment(p_assignment);
 if a.department_id='ST' then return '[]'::jsonb;end if;
 with departments as(select distinct s.department_id from public.sec_assignments s where s.person_id=a.person_id and s.archived_at is null and s.department_id<>'ST'),
 histories as(select d.department_id,h.month,h.points,h.source_level from departments d cross join lateral sec_private.monthly_point_history(d.department_id,'0001-01-01',date_trunc('month',current_date)::date,a.person_id) h)
 select coalesce(jsonb_agg(jsonb_build_object('month',to_char(h.month,'YYYY-MM'),'points',h.points,'sourceLevel',h.source_level,'groupId',h.department_id,'division',coalesce((select p.department_id from sec_private.person_division_history p where p.person_id=a.person_id and h.month between p.from_month and p.through_month),h.department_id)) order by h.month,h.department_id),'[]'::jsonb)
 into result from histories h;return result;
end $$;
create function public.sec_own_level_history(p_assignment uuid) returns jsonb
language sql stable security invoker set search_path='' as $$select sec_private.own_level_history(p_assignment)$$;
revoke all on function sec_private.own_level_history(uuid),public.sec_own_level_history(uuid) from public,anon,authenticated,service_role;
grant execute on function sec_private.own_level_history(uuid),public.sec_own_level_history(uuid) to authenticated;

create or replace function sec_private.supervisor_directory() returns jsonb
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
 where u.role='sec' and u.active and not u.is_test and s.archived_at is null;
 return result;
end $$;
create or replace function sec_private.supervisor_dashboard(p_assignment uuid default null) returns jsonb
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
 from public.sec_assignments s where s.archived_at is null and s.person_id=a.person_id and s.department_id=u.primary_department and (s.department_id<>'DA' or s.setting=u.setting);
 select coalesce(jsonb_agg(to_jsonb(r) order by r.published_at,r.id),'[]'::jsonb) into reports
 from public.sec_monthly_reports r where r.assignment_id=a.id;
 select coalesce(jsonb_agg(to_jsonb(w) order by w.published_at,w.id),'[]'::jsonb) into weekly
 from public.sec_weekly_snapshots w where w.assignment_id=a.id;
 -- Project only fields consumed by the shared premium aggregation.
 select coalesce(jsonb_agg(jsonb_build_object('id',r.id,'person_id',r.person_id,'department_id',r.department_id,
  'assignment_id',r.assignment_id,'month',r.month,'revision',r.revision,
  'payload',jsonb_build_object('premium',r.payload->'premium','extras',r.payload->'extras','extrasAvailable',r.payload->'extrasAvailable'))),'[]'::jsonb)
 into premium_rows from public.sec_monthly_reports r where r.person_id=a.person_id and r.department_id=a.department_id and exists(select 1 from public.sec_assignments x where x.id=r.assignment_id and x.archived_at is null);
 select coalesce(jsonb_agg(jsonb_build_object('report_id',r.report_id)),'[]'::jsonb) into receipts
 from public.sec_read_receipts r join public.sec_monthly_reports m on m.id=r.report_id
 where r.user_id=u.user_id and m.assignment_id=a.id;
 select coalesce(jsonb_object_agg(to_char(m.month,'YYYY-MM'),sec_private.own_rank(a.id,m.month)),'{}'::jsonb) into rankings
 from (select distinct r.month from public.sec_monthly_reports r where r.assignment_id=a.id) m;
 return jsonb_build_object('subject',jsonb_build_object('person_id',a.person_id,'display_name',coalesce(nullif(btrim(u.display_name),''),(select p.name from public.sec_people p where p.id=a.person_id)),
  'primary_department',u.primary_department,'setting',u.setting),'assignments',assignments,'selectedAssignment',a.id,
  'reports',reports,'weekly',weekly,'pointHistory',sec_private.own_point_history(a.id),'levelHistory',sec_private.own_level_history(a.id),'premiumRows',premium_rows,'read',receipts,'rankings',rankings);
end $$;
create or replace function sec_private.supervisor_group_source(p_department text) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare members jsonb;reports jsonb;weekly jsonb;premiums jsonb;points jsonb;
begin
 if not sec_private.is_supervisor() then raise exception 'Supervisor access required' using errcode='42501';end if;
 if p_department is null or p_department<>all(array['HE','DA','IM','LH','ST']) then raise exception 'Invalid division' using errcode='22023';end if;
 select coalesce(jsonb_agg(jsonb_build_object('person_id',u.person_id,'setting',u.setting)),'[]'::jsonb) into members
 from public.sec_accounts u where u.role='sec' and u.active and not u.is_test and u.person_id is not null and u.primary_department=p_department
 and exists(select 1 from public.sec_assignments a where a.person_id=u.person_id and a.department_id=p_department and a.archived_at is null and (p_department<>'DA' or a.setting=u.setting));
 select coalesce(jsonb_agg(to_jsonb(r)),'[]'::jsonb) into reports from public.sec_monthly_reports r
 join public.sec_assignments a on a.id=r.assignment_id
 join public.sec_accounts u on u.person_id=a.person_id and u.primary_department=a.department_id
 where a.department_id=p_department and a.archived_at is null and (p_department<>'DA' or a.setting=u.setting) and u.role='sec' and u.active and not u.is_test;
 select coalesce(jsonb_agg(to_jsonb(w)),'[]'::jsonb) into weekly from public.sec_weekly_snapshots w
 join public.sec_assignments a on a.id=w.assignment_id
 join public.sec_accounts u on u.person_id=a.person_id and u.primary_department=a.department_id
 where a.department_id=p_department and a.archived_at is null and (p_department<>'DA' or a.setting=u.setting) and u.role='sec' and u.active and not u.is_test;
 select coalesce(jsonb_agg(jsonb_build_object('id',r.id,'person_id',r.person_id,'assignment_id',r.assignment_id,
  'department_id',r.department_id,'month',r.month,'revision',r.revision,'payload',r.payload-'metrics'-'qualitative'-'changed')),'[]'::jsonb)
 into premiums from public.sec_monthly_reports r where r.department_id=p_department and exists(select 1 from public.sec_assignments x where x.id=r.assignment_id and x.archived_at is null) and exists(
  select 1 from jsonb_array_elements(members) m where (m->>'person_id')::uuid=r.person_id);
 select coalesce(jsonb_agg(jsonb_build_object('person_id',u.person_id,'history',sec_private.own_point_history(a.id))),'[]'::jsonb) into points
 from public.sec_accounts u join lateral (select s.id from public.sec_assignments s where s.archived_at is null and s.person_id=u.person_id and s.department_id=u.primary_department
  and (s.department_id<>'DA' or s.setting=u.setting) order by s.created_at,s.id limit 1) a on true
 where u.role='sec' and u.active and not u.is_test and u.primary_department=p_department;
 return jsonb_build_object('members',members,'reports',reports,'weekly',weekly,'premiumRows',premiums,'pointHistory',points);
end $$;
create or replace function sec_private.record_historical_points(p_rows jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare item jsonb; person uuid; department text; point_month date; source_month date;
 existing sec_private.historical_point_evidence; added integer:=0; reused integer:=0;
begin
 if not exists(select 1 from public.sec_accounts a where a.user_id=sec_private.actor_id()
  and a.role='app_admin' and a.active and not a.must_change_password)
 then raise exception 'Verified app administrator required' using errcode='42501';end if;
 if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows) not between 1 and 2000
 then raise exception 'Invalid evidence rows';end if;
 for item in select value from jsonb_array_elements(p_rows) loop
  if jsonb_typeof(item) is distinct from 'object'
   or not(item ?& array['personId','department','month','points','sourceMonth','sourceSha256','sourceFile','sourcePage'])
   or exists(select 1 from jsonb_object_keys(item) k where k<>all(array['personId','department','month','points','sourceMonth','sourceSha256','sourceFile','sourcePage','sourceLocator']))
   or jsonb_typeof(item->'points') is distinct from 'number' or jsonb_typeof(item->'sourcePage') is distinct from 'number'
  then raise exception 'Invalid evidence fields';end if;
  person:=(item->>'personId')::uuid;department:=item->>'department';point_month:=(item->>'month')::date;source_month:=(item->>'sourceMonth')::date;
  if department not in('HE','DA','IM','LH') or not department=any(sec_private.department_scope())
   or not exists(select 1 from public.sec_assignments a where a.person_id=person and a.department_id=department)
   or point_month is null or source_month is null or source_month>date_trunc('month',current_date)::date
   or (item->>'points')::numeric not in(1,2,3) or (item->>'sourcePage')::numeric<>(item->>'sourcePage')::integer
  then raise exception 'Unverified person, division or dated point';end if;
  if item ? 'sourceLocator' then
   if jsonb_typeof(item->'sourceLocator') is distinct from 'object' or item->'sourceLocator'->>'kind' is distinct from 'workbook'
    or coalesce(length(item->'sourceLocator'->>'sheet'),0) not between 1 and 150
    or coalesce(item->'sourceLocator'->>'column','') !~ '^[A-Z]{1,3}$'
    or jsonb_typeof(item->'sourceLocator'->'rows') is distinct from 'array'
   then raise exception 'Invalid workbook evidence locator';end if;
   if jsonb_array_length(item->'sourceLocator'->'rows') not between 1 and 100
    or exists(select 1 from jsonb_array_elements(item->'sourceLocator'->'rows') n where jsonb_typeof(n)<>'number' or n::text !~ '^[1-9][0-9]{0,6}$')
    or exists(select 1 from jsonb_object_keys(item->'sourceLocator') k where k<>all(array['kind','sheet','column','rows']))
   then raise exception 'Invalid workbook evidence rows';end if;
  end if;
  -- Existing closes retain authority, including ambiguous/missing results.
  if exists(select 1 from public.sec_monthly_reports r where r.person_id=person and r.department_id=department and r.month=point_month)
  then raise exception 'Published month already exists';end if;
  perform pg_advisory_xact_lock(hashtext('sec_historical_point:'||person::text||':'||department||':'||point_month::text));
  select * into existing from sec_private.historical_point_evidence e where e.person_id=person and e.department_id=department
   and e.month=point_month and e.source_sha256=item->>'sourceSha256' and e.source_page=(item->>'sourcePage')::integer;
  if existing.id is not null then
   if existing.points<>(item->>'points')::smallint or existing.source_month<>source_month or existing.source_file<>item->>'sourceFile' or existing.source_locator<>coalesce(item->'sourceLocator','{}'::jsonb)
   then raise exception 'Immutable evidence conflict';end if;
   reused:=reused+1;continue;
  end if;
  insert into sec_private.historical_point_evidence(person_id,department_id,month,points,source_month,source_sha256,source_file,source_page,imported_by,source_locator)
   values(person,department,point_month,(item->>'points')::smallint,source_month,item->>'sourceSha256',item->>'sourceFile',(item->>'sourcePage')::integer,sec_private.actor_id(),coalesce(item->'sourceLocator','{}'::jsonb));
  added:=added+1;
 end loop;
 if added>0 then perform sec_private.audit(null,'history.points_imported','history',null,jsonb_build_object('added',added));end if;
 return jsonb_build_object('inserted',added,'existing',reused);
end $$;
create or replace function sec_private.own_point_evidence() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare person uuid;result jsonb;
begin
 select a.person_id into person from public.sec_accounts a
 where a.user_id=sec_private.actor_id() and a.active and not a.must_change_password;
 if not found then raise exception 'Active password-unlocked account required' using errcode='42501';end if;
 if person is null then return '[]'::jsonb;end if;
 select coalesce(jsonb_agg(jsonb_build_object('department',e.department_id,'month',to_char(e.month,'YYYY-MM'),
  'points',e.points,'sourceMonth',to_char(e.source_month,'YYYY-MM'),'sourceFile',e.source_file,
  'sourceSha256',e.source_sha256,'sourcePage',case when e.source_locator->>'kind'='workbook' then null else e.source_page end) || case when e.source_locator='{}'::jsonb then '{}'::jsonb else jsonb_build_object('sourceLocator',e.source_locator) end order by e.department_id,e.month,e.source_sha256),'[]'::jsonb)
 into result from sec_private.historical_point_evidence e where e.person_id=person;
 return result;
end $$;
notify pgrst,'reload schema';
