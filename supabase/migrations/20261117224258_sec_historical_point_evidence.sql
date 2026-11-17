-- Point-only evidence from dated originals. Never fabricate a closing or a premium.
create table sec_private.historical_point_evidence(
 id uuid primary key default gen_random_uuid(),
 person_id uuid not null references public.sec_people(id) on delete cascade,
 department_id text not null references public.sec_departments(id),
 month date not null check(month=date_trunc('month',month)::date),
 points smallint not null check(points between 1 and 3),
 source_month date not null check(source_month=date_trunc('month',source_month)::date and source_month>=month),
 source_sha256 text not null check(source_sha256 ~ '^[a-f0-9]{64}$'),
 source_file text not null check(length(source_file) between 1 and 500),
 source_page integer not null check(source_page between 1 and 1000),
 imported_by uuid references auth.users(id) on delete set null,
 created_at timestamptz not null default now(),
 check(department_id in('HE','DA','IM','LH')),
 unique(person_id,department_id,month,source_sha256,source_page)
);
create index historical_point_person_month on sec_private.historical_point_evidence(person_id,department_id,month);
alter table sec_private.historical_point_evidence enable row level security;
alter table sec_private.historical_point_evidence force row level security;
revoke all on sec_private.historical_point_evidence from public,anon,authenticated,service_role;

create function sec_private.record_historical_points(p_rows jsonb) returns jsonb
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
   or exists(select 1 from jsonb_object_keys(item) k where k<>all(array['personId','department','month','points','sourceMonth','sourceSha256','sourceFile','sourcePage']))
   or jsonb_typeof(item->'points') is distinct from 'number' or jsonb_typeof(item->'sourcePage') is distinct from 'number'
  then raise exception 'Invalid evidence fields';end if;
  person:=(item->>'personId')::uuid;department:=item->>'department';point_month:=(item->>'month')::date;source_month:=(item->>'sourceMonth')::date;
  if department not in('HE','DA','IM','LH') or not department=any(sec_private.department_scope())
   or not exists(select 1 from public.sec_assignments a where a.person_id=person and a.department_id=department)
   or point_month is null or source_month is null or source_month>date_trunc('month',current_date)::date
   or (item->>'points')::numeric not in(1,2,3) or (item->>'sourcePage')::numeric<>(item->>'sourcePage')::integer
  then raise exception 'Unverified person, division or dated point';end if;
  -- Existing closes retain authority, including ambiguous/missing results.
  if exists(select 1 from public.sec_monthly_reports r where r.person_id=person and r.department_id=department and r.month=point_month)
  then raise exception 'Published month already exists';end if;
  perform pg_advisory_xact_lock(hashtext('sec_historical_point:'||person::text||':'||department||':'||point_month::text));
  select * into existing from sec_private.historical_point_evidence e where e.person_id=person and e.department_id=department
   and e.month=point_month and e.source_sha256=item->>'sourceSha256' and e.source_page=(item->>'sourcePage')::integer;
  if existing.id is not null then
   if existing.points<>(item->>'points')::smallint or existing.source_month<>source_month or existing.source_file<>item->>'sourceFile'
   then raise exception 'Immutable evidence conflict';end if;
   reused:=reused+1;continue;
  end if;
  insert into sec_private.historical_point_evidence(person_id,department_id,month,points,source_month,source_sha256,source_file,source_page,imported_by)
   values(person,department,point_month,(item->>'points')::smallint,source_month,item->>'sourceSha256',item->>'sourceFile',(item->>'sourcePage')::integer,sec_private.actor_id());
  added:=added+1;
 end loop;
 if added>0 then perform sec_private.audit(null,'history.points_imported','history',null,jsonb_build_object('added',added));end if;
 return jsonb_build_object('inserted',added,'existing',reused);
end $$;
create function public.sec_record_historical_points(p_rows jsonb) returns jsonb
language sql security invoker set search_path='' as $$select sec_private.record_historical_points(p_rows)$$;
revoke all on function sec_private.record_historical_points(jsonb),public.sec_record_historical_points(jsonb) from public,anon,authenticated,service_role;
grant execute on function sec_private.record_historical_points(jsonb),public.sec_record_historical_points(jsonb) to authenticated;

create or replace function sec_private.monthly_point_history(p_department text,p_from date,p_through date,p_person uuid default null)
returns table(person_id uuid,month date,points numeric,source_level text)
language sql stable security invoker set search_path='' as $$
 with active as (
  select distinct on(r.person_id,r.assignment_id,r.month) r.person_id,r.month,r.payload
  from public.sec_monthly_reports r
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
revoke all on function sec_private.monthly_point_history(text,date,date,uuid) from public,anon,authenticated,service_role;
notify pgrst,'reload schema';
