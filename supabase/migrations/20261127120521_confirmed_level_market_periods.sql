-- Confirmed source-market periods for point/level history; no employee data seeded.
do $guard$ declare item jsonb;begin
 for item in select value from jsonb_array_elements('[{"name": "history_rules", "hash": "137cff554e1d64ab98fae83a85a21d60"}, {"name": "original_monthly_point_history", "hash": "bbf518e315b26b7ddcd87b82fd7b3998"}, {"name": "own_level_history", "hash": "f7402f5d387609c5c297165f0bf66479"}, {"name": "own_point_history", "hash": "da4be17493bf54fcb1d66db4514064d5"}, {"name": "set_dashboard_history_rule", "hash": "ea48526b4775b6e542f68175d5f7e59b"}]'::jsonb) loop
 if not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='sec_private'
 and p.proname=item->>'name' and md5(regexp_replace(p.prosrc,'\s','','g'))=item->>'hash')
 then raise exception 'History function changed: %',item->>'name';end if;end loop;
end $guard$;


create table sec_private.level_market_periods(
 id uuid primary key default gen_random_uuid(),
 person_id uuid not null references public.sec_people(id) on delete cascade,
 department_id text not null references public.sec_departments(id),
 assignment_id uuid not null references public.sec_assignments(id),
 from_month date not null check(from_month=date_trunc('month',from_month)::date),
 through_month date check(through_month=date_trunc('month',through_month)::date and through_month>=from_month),
 note text not null check(length(btrim(note)) between 1 and 1000),
 confirmed_by uuid references auth.users(id) on delete set null,
 confirmed_at timestamptz not null default now(),
 unique(person_id,department_id,from_month),
 check(department_id in('HE','DA','IM','LH'))
);
create index level_market_period_lookup on sec_private.level_market_periods(person_id,department_id,from_month,through_month);
alter table sec_private.level_market_periods enable row level security;
alter table sec_private.level_market_periods force row level security;
revoke all on sec_private.level_market_periods from public,anon,authenticated,service_role;

create function sec_private.set_level_market_periods(p_person uuid,p_department text,p_periods jsonb,p_note text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare item jsonb;target public.sec_assignments;normalized jsonb;existing jsonb;same_note boolean;
begin
 if not sec_private.is_app_admin() then raise exception 'Verified app administrator required' using errcode='42501';end if;
 if p_person is null or p_department is null or p_department not in('HE','DA','IM','LH') or not p_department=any(sec_private.department_scope())
 or not exists(select 1 from public.sec_assignments a where a.person_id=p_person and a.department_id=p_department and a.archived_at is null)
 or p_periods is null or jsonb_typeof(p_periods)<>'array' or jsonb_array_length(p_periods)>48
 or p_note is null or length(btrim(p_note)) not between 1 and 1000
 then raise exception 'Invalid source-market periods' using errcode='22023';end if;
 for item in select value from jsonb_array_elements(p_periods) loop
  if jsonb_typeof(item)<>'object' or item->>'assignmentId' is null or not(item->>'assignmentId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
   or item->>'from' is null or not(item->>'from' ~ '^([0-9]{4})-(0[1-9]|1[0-2])$')
   or (item->>'through' is not null and not(item->>'through' ~ '^([0-9]{4})-(0[1-9]|1[0-2])$'))
   or exists(select 1 from jsonb_object_keys(item) k where k not in('assignmentId','from','through'))
  then raise exception 'Invalid market period entry' using errcode='22023';end if;
  if (item->>'from'||'-01')::date>date_trunc('month',current_date)::date
   or (item->>'through' is not null and ((item->>'through'||'-01')::date<(item->>'from'||'-01')::date or (item->>'through'||'-01')::date>date_trunc('month',current_date)::date))
  then raise exception 'Invalid market period dates' using errcode='22023';end if;
  select * into target from public.sec_assignments where id=(item->>'assignmentId')::uuid;
  if not found or target.person_id<>p_person or target.department_id<>p_department then raise exception 'Market belongs to another person or division' using errcode='22023';end if;
 end loop;
 if exists(select 1 from jsonb_array_elements(p_periods) with ordinality x(v,i) cross join jsonb_array_elements(p_periods) with ordinality y(v,i)
  where x.i<y.i and x.v->>'from'<=coalesce(y.v->>'through','9999-12') and y.v->>'from'<=coalesce(x.v->>'through','9999-12'))
 then raise exception 'Overlapping source-market periods' using errcode='22023';end if;
 perform pg_advisory_xact_lock(hashtext('sec_history_rule:'||p_person::text||':'||p_department));
 if jsonb_array_length(p_periods)>0 and exists(select 1 from sec_private.dashboard_history_rules where person_id=p_person and department_id=p_department and history_scope='assignment')
 then raise exception 'Separate-market scope requires its own source history' using errcode='22023';end if;
 select coalesce(jsonb_agg(jsonb_build_object('assignmentId',(v->>'assignmentId')::uuid,'from',v->>'from','through',v->>'through') order by v->>'from'),'[]'::jsonb) into normalized from jsonb_array_elements(p_periods) e(v);
 select coalesce(jsonb_agg(jsonb_build_object('assignmentId',r.assignment_id,'from',to_char(r.from_month,'YYYY-MM'),'through',to_char(r.through_month,'YYYY-MM')) order by r.from_month),'[]'::jsonb),
 coalesce(bool_and(r.note=btrim(p_note)),true) into existing,same_note from sec_private.level_market_periods r where r.person_id=p_person and r.department_id=p_department;
 if existing=normalized and same_note then return jsonb_build_object('changed',false,'periods',jsonb_array_length(normalized));end if;
 delete from sec_private.level_market_periods where person_id=p_person and department_id=p_department;
 insert into sec_private.level_market_periods(person_id,department_id,assignment_id,from_month,through_month,note,confirmed_by)
 select p_person,p_department,(v->>'assignmentId')::uuid,(v->>'from'||'-01')::date,case when v->>'through' is not null then(v->>'through'||'-01')::date end,btrim(p_note),sec_private.actor_id()
 from jsonb_array_elements(normalized) e(v);
 perform sec_private.audit(p_department,'history.market_periods_confirmed','person',p_person,jsonb_build_object('before',existing,'after',normalized));
 return jsonb_build_object('changed',true,'periods',jsonb_array_length(normalized));
end $$;
create function public.sec_set_level_market_periods(p_person uuid,p_department text,p_periods jsonb,p_note text) returns jsonb
language sql security invoker set search_path='' as $$select sec_private.set_level_market_periods(p_person,p_department,p_periods,p_note)$$;

create function sec_private.level_market_annotation(p_person uuid,p_department text,p_month date) returns jsonb
language sql stable security invoker set search_path='' as $$
 select coalesce((select jsonb_build_object('sourceAssignmentId',r.assignment_id,'sourceMarket',a.market)
 from sec_private.level_market_periods r join public.sec_assignments a on a.id=r.assignment_id
 where r.person_id=p_person and r.department_id=p_department and p_month>=r.from_month and(r.through_month is null or p_month<=r.through_month)),'{}'::jsonb)
$$;


create or replace function sec_private.set_dashboard_history_rule(p_person uuid,p_department text,p_scope text,p_note text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare old_rule sec_private.dashboard_history_rules;
begin
 if not sec_private.is_app_admin() then raise exception 'Verified app administrator required' using errcode='42501';end if;
 if p_person is null or p_department is null or p_scope is null or p_scope not in('division','assignment')
  or p_department not in('HE','DA','IM','LH') or not p_department=any(sec_private.department_scope())
  or not exists(select 1 from public.sec_assignments a where a.person_id=p_person and a.department_id=p_department and a.archived_at is null)
  or p_note is null or length(btrim(p_note)) not between 1 and 1000 then raise exception 'Invalid history rule' using errcode='22023';end if;
 perform pg_advisory_xact_lock(hashtext('sec_history_rule:'||p_person::text||':'||p_department));
 if p_scope='assignment' and exists(select 1 from sec_private.level_market_periods where person_id=p_person and department_id=p_department)
 then raise exception 'Confirmed transitions use division history; review before changing scope' using errcode='22023';end if;
 select * into old_rule from sec_private.dashboard_history_rules where person_id=p_person and department_id=p_department;
 if old_rule.history_scope=p_scope and old_rule.note=btrim(p_note) then return jsonb_build_object('changed',false,'scope',p_scope);end if;
 insert into sec_private.dashboard_history_rules(person_id,department_id,history_scope,note,confirmed_by)
 values(p_person,p_department,p_scope,btrim(p_note),sec_private.actor_id())
 on conflict(person_id,department_id) do update set history_scope=excluded.history_scope,note=excluded.note,confirmed_by=excluded.confirmed_by,updated_at=now();
 perform sec_private.audit(p_department,'history.scope_confirmed','person',p_person,jsonb_build_object('from',coalesce(old_rule.history_scope,'division'),'through',p_scope));
 return jsonb_build_object('changed',true,'scope',p_scope);
end $$;

create or replace function sec_private.original_monthly_point_history(p_department text,p_from date,p_through date,p_person uuid default null)
returns table(person_id uuid,month date,points numeric,source_level text)
language sql stable security invoker set search_path='' as $$
 with active as (
  select distinct on(r.person_id,r.assignment_id,r.month) r.person_id,r.month,r.payload
  from public.sec_monthly_reports r join public.sec_assignments scope_assignment on scope_assignment.id=r.assignment_id
   and(scope_assignment.archived_at is null or exists(select 1 from sec_private.level_market_periods p where p.person_id=r.person_id and p.department_id=r.department_id and p.assignment_id=r.assignment_id and r.month>=p.from_month and(p.through_month is null or r.month<=p.through_month)))
  where r.department_id=p_department and r.month between p_from and p_through and(p_person is null or r.person_id=p_person)
  and(not exists(select 1 from sec_private.level_market_periods p where p.person_id=r.person_id and p.department_id=r.department_id and r.month>=p.from_month and(p.through_month is null or r.month<=p.through_month))
    or exists(select 1 from sec_private.level_market_periods p where p.person_id=r.person_id and p.department_id=r.department_id and p.assignment_id=r.assignment_id and r.month>=p.from_month and(p.through_month is null or r.month<=p.through_month)))
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
   and not exists(select 1 from sec_private.level_market_periods p where p.person_id=e.person_id and p.department_id=e.department_id and e.month>=p.from_month and(p.through_month is null or e.month<=p.through_month))
 ),selected_missing as(
  select p.person_id,d.month::date as month,null::numeric as value,null::text as level from sec_private.level_market_periods p
  cross join lateral generate_series(greatest(p.from_month,p_from),least(coalesce(p.through_month,p_through),p_through,date_trunc('month',current_date)::date),'1 month'::interval) d(month)
  where p.department_id=p_department and(p_person is null or p.person_id=p_person)
   and not exists(select 1 from active a where a.person_id=p.person_id and a.month=d.month::date)
 ),combined as(select * from typed union all select * from evidence union all select * from selected_missing)
 select t.person_id,t.month,
  case when count(t.value)=count(*) and min(t.value)=max(t.value) then max(t.value) end,
  case when count(distinct t.level)=1 then max(t.level) end
 from combined t group by t.person_id,t.month
$$;

create or replace function sec_private.own_point_history(p_assignment uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare a public.sec_assignments;result jsonb;
begin
 a:=sec_private.dashboard_assignment(p_assignment);
 if a.department_id='ST' then return '[]'::jsonb;end if;
 select coalesce(jsonb_agg(jsonb_build_object('month',to_char(h.month,'YYYY-MM'),'points',h.points,'sourceLevel',h.source_level)
  ||sec_private.absence_annotation(a.person_id,a.department_id,h.month)||sec_private.level_market_annotation(a.person_id,a.department_id,h.month) order by h.month),'[]'::jsonb)
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
  ||sec_private.absence_annotation(a.person_id,h.department_id,h.month)||sec_private.level_market_annotation(a.person_id,h.department_id,h.month) order by h.month,h.department_id),'[]'::jsonb)
 into result from histories h;return result;
end $$;

create or replace function sec_private.history_rules(p_person uuid default null) returns jsonb
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
 return jsonb_build_object('settings',settings,'absences',absences,'marketPeriods',
 (select coalesce(jsonb_agg(jsonb_build_object('department',r.department_id,'assignmentId',r.assignment_id,'market',a.market,
 'from',to_char(r.from_month,'YYYY-MM'),'through',to_char(r.through_month,'YYYY-MM'),'note',r.note,'confirmedAt',r.confirmed_at) order by r.from_month),'[]'::jsonb)
 from sec_private.level_market_periods r join public.sec_assignments a on a.id=r.assignment_id where r.person_id=person));
end $$;

revoke all on function sec_private.level_market_annotation(uuid,text,date) from public,anon,authenticated,service_role;
revoke all on function sec_private.set_level_market_periods(uuid,text,jsonb,text),public.sec_set_level_market_periods(uuid,text,jsonb,text) from public,anon,authenticated,service_role;
grant execute on function sec_private.set_level_market_periods(uuid,text,jsonb,text),public.sec_set_level_market_periods(uuid,text,jsonb,text) to authenticated;
notify pgrst,'reload schema';
