-- Confirmed absences and explicitly opted-in market dashboards.
-- No employee IDs or sample data are seeded by this migration.
DO $guard$
declare item jsonb;
begin
 for item in select value from jsonb_array_elements('[
  {"name":"monthly_point_history","hash":"bbf518e315b26b7ddcd87b82fd7b3998"},
  {"name":"own_point_history","hash":"c28b4f155563316e7f8341d340c1fb3c"},
  {"name":"own_level_history","hash":"24ffe1456fd7f7ed3f94d909072a8785"},
  {"name":"supervisor_dashboard","hash":"96142a95b887c23546492df13fd0045e"},
  {"name":"own_rank","hash":"64256c116a7ca6fcd0b371d1c4476403"}]'::jsonb) loop
  if not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='sec_private'
   and p.proname=item->>'name' and md5(regexp_replace(p.prosrc,'\s','','g'))=item->>'hash')
  then raise exception 'History function changed: %',item->>'name';end if;
 end loop;
end $guard$;

create table sec_private.dashboard_history_rules(
 person_id uuid not null references public.sec_people(id) on delete cascade,
 department_id text not null references public.sec_departments(id),
 history_scope text not null check(history_scope in('division','assignment')),
 note text not null check(length(btrim(note)) between 1 and 1000),
 confirmed_by uuid references auth.users(id) on delete set null,
 updated_at timestamptz not null default now(),
 primary key(person_id,department_id),
 check(department_id in('HE','DA','IM','LH'))
);
create table sec_private.level_absences(
 id uuid primary key default gen_random_uuid(),
 person_id uuid not null references public.sec_people(id) on delete cascade,
 department_id text not null references public.sec_departments(id),
 from_month date not null check(from_month=date_trunc('month',from_month)::date),
 through_month date not null check(through_month=date_trunc('month',through_month)::date and through_month>=from_month),
 note text not null check(length(btrim(note)) between 1 and 1000),
 confirmed_by uuid references auth.users(id) on delete set null,
 created_at timestamptz not null default now(),
 unique(person_id,department_id,from_month,through_month),
 check(department_id in('HE','DA','IM','LH'))
);
create index level_absence_person_month on sec_private.level_absences(person_id,department_id,from_month,through_month);
alter table sec_private.dashboard_history_rules enable row level security;
alter table sec_private.dashboard_history_rules force row level security;
alter table sec_private.level_absences enable row level security;
alter table sec_private.level_absences force row level security;
revoke all on sec_private.dashboard_history_rules,sec_private.level_absences from public,anon,authenticated,service_role;

create function sec_private.set_dashboard_history_rule(p_person uuid,p_department text,p_scope text,p_note text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare old_rule sec_private.dashboard_history_rules;
begin
 if not sec_private.is_app_admin() then raise exception 'Verified app administrator required' using errcode='42501';end if;
 if p_person is null or p_department is null or p_scope is null or p_scope not in('division','assignment')
  or p_department not in('HE','DA','IM','LH') or not p_department=any(sec_private.department_scope())
  or not exists(select 1 from public.sec_assignments a where a.person_id=p_person and a.department_id=p_department and a.archived_at is null)
  or p_note is null or length(btrim(p_note)) not between 1 and 1000 then raise exception 'Invalid history rule' using errcode='22023';end if;
 perform pg_advisory_xact_lock(hashtext('sec_history_rule:'||p_person::text||':'||p_department));
 select * into old_rule from sec_private.dashboard_history_rules where person_id=p_person and department_id=p_department;
 if old_rule.history_scope=p_scope and old_rule.note=btrim(p_note) then return jsonb_build_object('changed',false,'scope',p_scope);end if;
 insert into sec_private.dashboard_history_rules(person_id,department_id,history_scope,note,confirmed_by)
 values(p_person,p_department,p_scope,btrim(p_note),sec_private.actor_id())
 on conflict(person_id,department_id) do update set history_scope=excluded.history_scope,note=excluded.note,confirmed_by=excluded.confirmed_by,updated_at=now();
 perform sec_private.audit(p_department,'history.scope_confirmed','person',p_person,jsonb_build_object('from',coalesce(old_rule.history_scope,'division'),'through',p_scope));
 return jsonb_build_object('changed',true,'scope',p_scope);
end $$;
create function public.sec_set_dashboard_history_rule(p_person uuid,p_department text,p_scope text,p_note text) returns jsonb
language sql security invoker set search_path='' as $$select sec_private.set_dashboard_history_rule(p_person,p_department,p_scope,p_note)$$;

create function sec_private.confirm_level_absence(p_person uuid,p_department text,p_from date,p_through date,p_note text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare existing sec_private.level_absences;result uuid;
begin
 if not sec_private.is_app_admin() then raise exception 'Verified app administrator required' using errcode='42501';end if;
 if p_person is null or p_department is null or p_department not in('HE','DA','IM','LH') or not p_department=any(sec_private.department_scope())
  or not exists(select 1 from public.sec_assignments a where a.person_id=p_person and a.department_id=p_department and a.archived_at is null)
  or p_from is null or p_through is null or extract(day from p_from)<>1 or extract(day from p_through)<>1
  or p_through<p_from or p_through>date_trunc('month',current_date)::date or p_through>p_from+interval '24 months'
  or p_note is null or length(btrim(p_note)) not between 1 and 1000 then raise exception 'Invalid confirmed absence' using errcode='22023';end if;
 perform pg_advisory_xact_lock(hashtext('sec_history_rule:'||p_person::text||':'||p_department));
 select * into existing from sec_private.level_absences where person_id=p_person and department_id=p_department and from_month<=p_through and through_month>=p_from;
 if found then
  if existing.from_month=p_from and existing.through_month=p_through and existing.note=btrim(p_note) then
   return jsonb_build_object('changed',false,'id',existing.id);
  end if;
  raise exception 'Overlapping absence requires review' using errcode='22023';
 end if;
 insert into sec_private.level_absences(person_id,department_id,from_month,through_month,note,confirmed_by)
 values(p_person,p_department,p_from,p_through,btrim(p_note),sec_private.actor_id()) returning id into result;
 perform sec_private.audit(p_department,'history.absence_confirmed','person',p_person,jsonb_build_object('from',p_from,'through',p_through,'effect','exclude-level-points'));
 return jsonb_build_object('changed',true,'id',result);
end $$;
create function public.sec_confirm_level_absence(p_person uuid,p_department text,p_from date,p_through date,p_note text) returns jsonb
language sql security invoker set search_path='' as $$select sec_private.confirm_level_absence(p_person,p_department,p_from,p_through,p_note)$$;

create function sec_private.original_monthly_point_history(p_department text,p_from date,p_through date,p_person uuid default null)
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

create or replace function sec_private.monthly_point_history(p_department text,p_from date,p_through date,p_person uuid default null)
returns table(person_id uuid,month date,points numeric,source_level text)
language sql stable security invoker set search_path='' as $$
 with original as(select * from sec_private.original_monthly_point_history(p_department,p_from,p_through,p_person)),
 absence as(
  select distinct a.person_id,d.month::date as month
  from sec_private.level_absences a
  cross join lateral generate_series(greatest(a.from_month,p_from),least(a.through_month,p_through),'1 month'::interval) d(month)
  where a.department_id=p_department and (p_person is null or a.person_id=p_person)
 )
 select coalesce(o.person_id,a.person_id),coalesce(o.month,a.month),
  case when a.person_id is not null then 0::numeric else o.points end,
  case when a.person_id is not null then null::text else o.source_level end
 from original o full join absence a on a.person_id=o.person_id and a.month=o.month
$$;
create function sec_private.absence_annotation(p_person uuid,p_department text,p_month date) returns jsonb
language sql stable security invoker set search_path='' as $$
 select case when exists(select 1 from sec_private.level_absences a where a.person_id=p_person and a.department_id=p_department and p_month between a.from_month and a.through_month)
  then jsonb_build_object('participation','absent','sourcePoints',(select h.points from sec_private.original_monthly_point_history(p_department,p_month,p_month,p_person) h))
  else '{}'::jsonb end
$$;
create or replace function sec_private.own_point_history(p_assignment uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare a public.sec_assignments;result jsonb;
begin
 a:=sec_private.dashboard_assignment(p_assignment);
 if a.department_id='ST' then return '[]'::jsonb;end if;
 select coalesce(jsonb_agg(jsonb_build_object('month',to_char(h.month,'YYYY-MM'),'points',h.points,'sourceLevel',h.source_level)
  ||sec_private.absence_annotation(a.person_id,a.department_id,h.month) order by h.month),'[]'::jsonb)
 into result from sec_private.monthly_point_history(a.department_id,'0001-01-01',date_trunc('month',current_date)::date,a.person_id) h;
 return result;
end $$;
create or replace function sec_private.own_level_history(p_assignment uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare a public.sec_assignments;result jsonb;
begin
 a:=sec_private.dashboard_assignment(p_assignment);
 if a.department_id='ST' then return '[]'::jsonb;end if;
 with departments as(select distinct s.department_id from public.sec_assignments s where s.person_id=a.person_id and s.archived_at is null and s.department_id<>'ST'),
 histories as(select d.department_id,h.month,h.points,h.source_level from departments d cross join lateral sec_private.monthly_point_history(d.department_id,'0001-01-01',date_trunc('month',current_date)::date,a.person_id) h)
 select coalesce(jsonb_agg(jsonb_build_object('month',to_char(h.month,'YYYY-MM'),'points',h.points,'sourceLevel',h.source_level,'groupId',h.department_id,
  'division',coalesce((select p.department_id from sec_private.person_division_history p where p.person_id=a.person_id and h.month between p.from_month and p.through_month),h.department_id))
  ||sec_private.absence_annotation(a.person_id,h.department_id,h.month) order by h.month,h.department_id),'[]'::jsonb)
 into result from histories h;return result;
end $$;

create function sec_private.dashboard_history(p_assignment uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare a public.sec_assignments;scope text;points jsonb;levels jsonb;
begin
 a:=sec_private.dashboard_assignment(p_assignment);
 select r.history_scope into scope from sec_private.dashboard_history_rules r where r.person_id=a.person_id and r.department_id=a.department_id;
 scope:=coalesce(scope,'division');
 if scope='division' or a.department_id='ST' then
  return jsonb_build_object('historyScope','division','pointHistory',sec_private.own_point_history(a.id),'levelHistory',sec_private.own_level_history(a.id));
 end if;
 -- A separate market never borrows another assignment's points, category, or unscoped evidence.
 with latest as(
  select distinct on(r.month) r.month,r.payload from public.sec_monthly_reports r
  where r.assignment_id=a.id and r.month<=date_trunc('month',current_date)::date
  order by r.month,r.revision desc
 ),typed as(
  select r.month,
   case when jsonb_typeof(r.payload->'points')='number' then case when(r.payload->>'points')::numeric between 0 and 3 then(r.payload->>'points')::numeric end end as points,
   case upper(regexp_replace(coalesce(r.payload->>'sourceLevel',''),'\s','','g')) when 'SEC' then 'SEC' when 'SEC+' then 'SEC+' when 'SECPRO' then 'SEC Pro' end as source_level
  from latest r
 ),absence as(
  select distinct d.month::date as month from sec_private.level_absences e
  cross join lateral generate_series(e.from_month,e.through_month,'1 month'::interval) d(month)
  where e.person_id=a.person_id and e.department_id=a.department_id
 ),combined as(
  select coalesce(t.month,e.month) as month,case when e.month is not null then 0 else t.points end as points,
   case when e.month is not null then null else t.source_level end as source_level
  from typed t full join absence e on e.month=t.month
 )
 select coalesce(jsonb_agg(jsonb_build_object('month',to_char(t.month,'YYYY-MM'),'points',t.points,'sourceLevel',t.source_level)
  ||sec_private.absence_annotation(a.person_id,a.department_id,t.month) order by t.month),'[]'::jsonb)
 into points from combined t;
 select coalesce(jsonb_agg(p.value||jsonb_build_object('groupId',a.department_id,'division',coalesce(
  (select d.department_id from sec_private.person_division_history d where d.person_id=a.person_id and ((p.value->>'month')||'-01')::date between d.from_month and d.through_month),a.department_id)) order by p.value->>'month'),'[]'::jsonb)
 into levels from jsonb_array_elements(points) p(value);
 return jsonb_build_object('historyScope',scope,'pointHistory',points,'levelHistory',levels);
end $$;
create function public.sec_dashboard_history(p_assignment uuid) returns jsonb
language sql stable security invoker set search_path='' as $$select sec_private.dashboard_history(p_assignment)$$;

create function sec_private.history_rules(p_person uuid default null) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare person uuid;settings jsonb;absences jsonb;
begin
 if sec_private.actor_id() is null then raise exception 'Verified account required' using errcode='42501';end if;
 person:=coalesce(p_person,sec_private.actor_person());
 if p_person is not null and not sec_private.is_app_admin() and p_person is distinct from sec_private.actor_person()
 then raise exception 'Own history rules only' using errcode='42501';end if;
 select coalesce(jsonb_agg(jsonb_build_object('department',r.department_id,'scope',r.history_scope,'note',r.note,'updatedAt',r.updated_at) order by r.department_id),'[]'::jsonb)
 into settings from sec_private.dashboard_history_rules r where r.person_id=person;
 select coalesce(jsonb_agg(jsonb_build_object('id',r.id,'department',r.department_id,'from',to_char(r.from_month,'YYYY-MM'),'through',to_char(r.through_month,'YYYY-MM'),'note',r.note,'confirmedAt',r.created_at) order by r.from_month),'[]'::jsonb)
 into absences from sec_private.level_absences r where r.person_id=person;
 return jsonb_build_object('settings',settings,'absences',absences);
end $$;
create function public.sec_history_rules(p_person uuid default null) returns jsonb
language sql stable security invoker set search_path='' as $$select sec_private.history_rules(p_person)$$;

create or replace function sec_private.supervisor_dashboard(p_assignment uuid default null) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare a public.sec_assignments; u public.sec_accounts; reports jsonb; weekly jsonb; assignments jsonb; premium_rows jsonb; receipts jsonb; rankings jsonb; history jsonb;
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
 history:=sec_private.dashboard_history(a.id);
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
 into premium_rows from public.sec_monthly_reports r where r.person_id=a.person_id and r.department_id=a.department_id and ((history->>'historyScope')<>'assignment' or r.assignment_id=a.id) and exists(select 1 from public.sec_assignments x where x.id=r.assignment_id and x.archived_at is null);
 select coalesce(jsonb_agg(jsonb_build_object('report_id',r.report_id)),'[]'::jsonb) into receipts
 from public.sec_read_receipts r join public.sec_monthly_reports m on m.id=r.report_id
 where r.user_id=u.user_id and m.assignment_id=a.id;
 select coalesce(jsonb_object_agg(to_char(m.month,'YYYY-MM'),case when history->>'historyScope'='assignment' then jsonb_build_object('pool',0,'rank',null,'outsideTopTen',false,'reason','market-scope') else sec_private.own_rank(a.id,m.month) end),'{}'::jsonb) into rankings
 from (select distinct r.month from public.sec_monthly_reports r where r.assignment_id=a.id) m;
 return jsonb_build_object('subject',jsonb_build_object('person_id',a.person_id,'display_name',coalesce(nullif(btrim(u.display_name),''),(select p.name from public.sec_people p where p.id=a.person_id)),
  'primary_department',u.primary_department,'setting',u.setting),'assignments',assignments,'selectedAssignment',a.id,
  'reports',reports,'weekly',weekly,'pointHistory',history->'pointHistory','levelHistory',history->'levelHistory','historyScope',history->>'historyScope','premiumRows',premium_rows,'read',receipts,'rankings',rankings);
end $$;

revoke all on function sec_private.original_monthly_point_history(text,date,date,uuid),sec_private.absence_annotation(uuid,text,date) from public,anon,authenticated,service_role;
revoke all on function sec_private.set_dashboard_history_rule(uuid,text,text,text),public.sec_set_dashboard_history_rule(uuid,text,text,text),
 sec_private.confirm_level_absence(uuid,text,date,date,text),public.sec_confirm_level_absence(uuid,text,date,date,text),
 sec_private.dashboard_history(uuid),public.sec_dashboard_history(uuid),
 sec_private.history_rules(uuid),public.sec_history_rules(uuid)
 from public,anon,authenticated,service_role;
grant execute on function sec_private.set_dashboard_history_rule(uuid,text,text,text),public.sec_set_dashboard_history_rule(uuid,text,text,text),
 sec_private.confirm_level_absence(uuid,text,date,date,text),public.sec_confirm_level_absence(uuid,text,date,date,text),
 sec_private.dashboard_history(uuid),public.sec_dashboard_history(uuid),
 sec_private.history_rules(uuid),public.sec_history_rules(uuid) to authenticated;
notify pgrst,'reload schema';
