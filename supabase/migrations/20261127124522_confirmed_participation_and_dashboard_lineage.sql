do $guard$ declare item jsonb;begin for item in select value from jsonb_array_elements('[{"name": "closing_comments", "hash": "25b3efb82b08b18a9ee6e2e71a051cc8"}, {"name": "dashboard_history", "hash": "59352222f849b2d5a83c90c904bfb0b6"}, {"name": "history_rules", "hash": "75b8f88da626d44635397f302ddf78c1"}, {"name": "own_level_history", "hash": "6c56960a72967d962ea8de9906a9d13e"}, {"name": "own_point_history", "hash": "ae6e50321dd8dfd4409547424c469b5c"}, {"name": "own_rank", "hash": "64256c116a7ca6fcd0b371d1c4476403"}, {"name": "set_dashboard_history_rule", "hash": "739a9f5eeafa1236dc1b477b75c4bed3"}, {"name": "supervisor_dashboard", "hash": "c49a8872569689094384bd7399a814f9"}]'::jsonb) loop if not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='sec_private' and p.proname=item->>'name' and md5(regexp_replace(p.prosrc,'\s','','g'))=item->>'hash') then raise exception 'History function changed: %',item->>'name';end if;end loop;end $guard$;

-- User-confirmed start months and explicitly confirmed dashboard predecessors.
-- Configuration is stored separately; no employee rows or values are seeded.
create table sec_private.participation_starts(
 person_id uuid not null references public.sec_people(id) on delete cascade,
 department_id text not null references public.sec_departments(id),
 first_month date not null check(first_month=date_trunc('month',first_month)::date),
 note text not null check(length(btrim(note)) between 1 and 1000),
 confirmed_by uuid references auth.users(id) on delete set null,
 confirmed_at timestamptz not null default now(),
 primary key(person_id,department_id),check(department_id in('HE','DA','IM','LH'))
);
create table sec_private.dashboard_lineage(
 id uuid primary key default gen_random_uuid(),
 assignment_id uuid not null references public.sec_assignments(id) on delete cascade,
 source_assignment_id uuid not null references public.sec_assignments(id),
 market_assignment_id uuid not null references public.sec_assignments(id),
 from_month date not null check(from_month=date_trunc('month',from_month)::date),
 through_month date check(through_month=date_trunc('month',through_month)::date and through_month>=from_month),
 note text not null check(length(btrim(note)) between 1 and 1000),
 confirmed_by uuid references auth.users(id) on delete set null,
 confirmed_at timestamptz not null default now(),unique(assignment_id,from_month)
);
create index dashboard_lineage_source_period on sec_private.dashboard_lineage(assignment_id,source_assignment_id,from_month,through_month);
alter table sec_private.participation_starts enable row level security;
alter table sec_private.participation_starts force row level security;
alter table sec_private.dashboard_lineage enable row level security;
alter table sec_private.dashboard_lineage force row level security;
revoke all on sec_private.participation_starts,sec_private.dashboard_lineage from public,anon,authenticated,service_role;

create function sec_private.set_participation_start(p_person uuid,p_department text,p_month date,p_note text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare previous sec_private.participation_starts;
begin
 if not sec_private.is_app_admin() then raise exception 'Verified app administrator required' using errcode='42501';end if;
 if p_person is null or p_department is null or p_department not in('HE','DA','IM','LH') or not p_department=any(sec_private.department_scope())
 or not exists(select 1 from public.sec_assignments where person_id=p_person and department_id=p_department and archived_at is null)
 or (p_month is not null and(p_month<>date_trunc('month',p_month)::date or p_month>date_trunc('month',current_date)::date))
 or p_note is null or length(btrim(p_note)) not between 1 and 1000 then raise exception 'Invalid confirmed SEC start' using errcode='22023';end if;
 perform pg_advisory_xact_lock(hashtext('sec_history_rule:'||p_person::text||':'||p_department));
 select * into previous from sec_private.participation_starts where person_id=p_person and department_id=p_department;
 if (p_month is null and previous.person_id is null) or (previous.first_month=p_month and previous.note=btrim(p_note))
 then return jsonb_build_object('changed',false,'month',to_char(p_month,'YYYY-MM'));end if;
 if p_month is not null and(
  exists(select 1 from public.sec_monthly_reports r where r.person_id=p_person and r.month<p_month
   and((jsonb_typeof(r.payload->'points')='number' and case when jsonb_typeof(r.payload->'points')='number' then (r.payload->>'points')::numeric between 0 and 3 else false end)
    or upper(regexp_replace(coalesce(r.payload->>'sourceLevel',''),'\s','','g')) in('SEC','SEC+','SECPRO')))
  or exists(select 1 from sec_private.historical_point_evidence e where e.person_id=p_person and e.month<p_month))
 then raise exception 'Earlier evidence requires review before confirming a later start' using errcode='22023';end if;
 delete from sec_private.participation_starts where person_id=p_person and department_id=p_department;
 if p_month is not null then
 insert into sec_private.participation_starts(person_id,department_id,first_month,note,confirmed_by)
 values(p_person,p_department,p_month,btrim(p_note),sec_private.actor_id());end if;
 perform sec_private.audit(p_department,'history.participation_start_confirmed','person',p_person,jsonb_build_object('before',previous.first_month,'after',p_month));
 return jsonb_build_object('changed',true,'month',to_char(p_month,'YYYY-MM'));
end $$;
create function public.sec_set_participation_start(p_person uuid,p_department text,p_month date,p_note text) returns jsonb
language sql security invoker set search_path='' as $$select sec_private.set_participation_start(p_person,p_department,p_month,p_note)$$;

create function sec_private.project_participation_start(p_history jsonb,p_person uuid,p_department text) returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare first_month date;result jsonb;
begin
 select s.first_month into first_month from sec_private.participation_starts s where s.person_id=p_person and s.department_id=p_department;
 if first_month is null then return p_history;end if;
 with supplied as(select v from jsonb_array_elements(p_history)e(v)),projected as(
  select case when(v->>'month'||'-01')::date<first_month
   then v||jsonb_build_object('points',null,'sourceLevel',null,'sourcePoints',v->'points','participation','not-started') else v end as v from supplied
  union all select jsonb_build_object('month',to_char(d.month,'YYYY-MM'),'points',null,'sourceLevel',null,'participation','not-started')
  from generate_series(first_month-interval '11 months',first_month-interval '1 month','1 month'::interval)d(month)
  where not exists(select 1 from supplied s where s.v->>'month'=to_char(d.month,'YYYY-MM'))
 )
 select coalesce(jsonb_agg(v order by v->>'month'),'[]'::jsonb) into result from projected;
 return result;
end $$;
create function sec_private.project_level_starts(p_history jsonb,p_person uuid) returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare department text;rows jsonb;projected jsonb;result jsonb:='[]'::jsonb;
begin
 if not exists(select 1 from sec_private.participation_starts where person_id=p_person) then return p_history;end if;
 for department in select distinct v->>'groupId' from jsonb_array_elements(p_history)e(v) loop
  select coalesce(jsonb_agg(v order by v->>'month'),'[]'::jsonb) into rows from jsonb_array_elements(p_history)e(v) where v->>'groupId'=department;
  projected:=sec_private.project_participation_start(rows,p_person,department);
  select coalesce(jsonb_agg(v||jsonb_build_object('groupId',department,'division',coalesce(v->>'division',department))),'[]'::jsonb)
   into projected from jsonb_array_elements(projected)e(v);
  result:=result||projected;
 end loop;
 return(select coalesce(jsonb_agg(v order by v->>'month',v->>'groupId'),'[]'::jsonb) from jsonb_array_elements(result)e(v));
end $$;

create function sec_private.set_dashboard_lineage(p_assignment uuid,p_periods jsonb,p_note text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare target public.sec_assignments;source public.sec_assignments;market public.sec_assignments;item jsonb;normalized jsonb;existing jsonb;same_note boolean;
begin
 if not sec_private.is_app_admin() then raise exception 'Verified app administrator required' using errcode='42501';end if;
 select * into target from public.sec_assignments where id=p_assignment and archived_at is null;
 if target.id is null or target.department_id not in('HE','DA','IM','LH') or not target.department_id=any(sec_private.department_scope())
 or p_periods is null or jsonb_typeof(p_periods)<>'array' or jsonb_array_length(p_periods)>48
 or p_note is null or length(btrim(p_note)) not between 1 and 1000 then raise exception 'Invalid confirmed dashboard lineage' using errcode='22023';end if;
 for item in select value from jsonb_array_elements(p_periods) loop
  if jsonb_typeof(item)<>'object' or item->>'sourceAssignmentId' is null or not(item->>'sourceAssignmentId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
   or item->>'marketAssignmentId' is null or not(item->>'marketAssignmentId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
   or item->>'from' is null or not(item->>'from' ~ '^[0-9]{4}-(0[1-9]|1[0-2])$')
   or(item->>'through' is not null and not(item->>'through' ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'))
   or exists(select 1 from jsonb_object_keys(item)k where k not in('sourceAssignmentId','marketAssignmentId','from','through'))
  then raise exception 'Invalid lineage period entry' using errcode='22023';end if;
  if(item->>'from'||'-01')::date>date_trunc('month',current_date)::date
   or(item->>'through' is not null and((item->>'through'||'-01')::date<(item->>'from'||'-01')::date or(item->>'through'||'-01')::date>date_trunc('month',current_date)::date))
  then raise exception 'Invalid lineage period dates' using errcode='22023';end if;
  select * into source from public.sec_assignments where id=(item->>'sourceAssignmentId')::uuid;
  select * into market from public.sec_assignments where id=(item->>'marketAssignmentId')::uuid;
  if source.id is null or market.id is null or source.person_id<>target.person_id or market.person_id<>target.person_id
   or source.department_id<>target.department_id or market.department_id<>target.department_id or source.setting<>target.setting or market.setting<>target.setting
  then raise exception 'Lineage belongs to another person or division' using errcode='22023';end if;
 end loop;
 if exists(select 1 from jsonb_array_elements(p_periods) with ordinality x(v,i) cross join jsonb_array_elements(p_periods) with ordinality y(v,i)
  where x.i<y.i and x.v->>'from'<=coalesce(y.v->>'through','9999-12') and y.v->>'from'<=coalesce(x.v->>'through','9999-12'))
 then raise exception 'Overlapping dashboard lineage' using errcode='22023';end if;
 perform pg_advisory_xact_lock(hashtext('sec_history_rule:'||target.person_id::text||':'||target.department_id));
 if jsonb_array_length(p_periods)>0 and not exists(select 1 from sec_private.dashboard_history_rules where person_id=target.person_id and department_id=target.department_id and history_scope='assignment')
 then raise exception 'Explicit separate-market scope required' using errcode='22023';end if;
 select coalesce(jsonb_agg(jsonb_build_object('sourceAssignmentId',(v->>'sourceAssignmentId')::uuid,'marketAssignmentId',(v->>'marketAssignmentId')::uuid,
  'from',v->>'from','through',v->>'through') order by v->>'from'),'[]'::jsonb) into normalized from jsonb_array_elements(p_periods)e(v);
 select coalesce(jsonb_agg(jsonb_build_object('sourceAssignmentId',r.source_assignment_id,'marketAssignmentId',r.market_assignment_id,
  'from',to_char(r.from_month,'YYYY-MM'),'through',to_char(r.through_month,'YYYY-MM')) order by r.from_month),'[]'::jsonb),
  coalesce(bool_and(r.note=btrim(p_note)),true) into existing,same_note from sec_private.dashboard_lineage r where r.assignment_id=target.id;
 if existing=normalized and same_note then return jsonb_build_object('changed',false,'periods',jsonb_array_length(normalized));end if;
 delete from sec_private.dashboard_lineage where assignment_id=target.id;
 insert into sec_private.dashboard_lineage(assignment_id,source_assignment_id,market_assignment_id,from_month,through_month,note,confirmed_by)
 select target.id,(v->>'sourceAssignmentId')::uuid,(v->>'marketAssignmentId')::uuid,(v->>'from'||'-01')::date,
  case when v->>'through' is not null then(v->>'through'||'-01')::date end,btrim(p_note),sec_private.actor_id() from jsonb_array_elements(normalized)e(v);
 perform sec_private.audit(target.department_id,'history.dashboard_lineage_confirmed','assignment',target.id,jsonb_build_object('before',existing,'after',normalized));
 return jsonb_build_object('changed',true,'periods',jsonb_array_length(normalized));
end $$;
create function public.sec_set_dashboard_lineage(p_assignment uuid,p_periods jsonb,p_note text) returns jsonb
language sql security invoker set search_path='' as $$select sec_private.set_dashboard_lineage(p_assignment,p_periods,p_note)$$;

create function sec_private.matches_dashboard_source(p_assignment uuid,p_source uuid,p_month date) returns boolean
language sql stable security invoker set search_path='' as $$
 select case when exists(select 1 from sec_private.dashboard_lineage where assignment_id=p_assignment)
 then exists(select 1 from sec_private.dashboard_lineage where assignment_id=p_assignment and source_assignment_id=p_source and p_month>=from_month and(through_month is null or p_month<=through_month))
 else p_assignment=p_source end
$$;
create function sec_private.lineage_annotation(p_assignment uuid,p_month date) returns jsonb
language sql stable security invoker set search_path='' as $$
 select coalesce((select jsonb_build_object('sourceAssignmentId',r.source_assignment_id,'sourceMarket',s.market,'marketAssignmentId',m.id,'market',m.market)
 from sec_private.dashboard_lineage r join public.sec_assignments s on s.id=r.source_assignment_id join public.sec_assignments m on m.id=r.market_assignment_id
 where r.assignment_id=p_assignment and p_month>=r.from_month and(r.through_month is null or p_month<=r.through_month)),'{}'::jsonb)
$$;
create function sec_private.lineage_content(p_assignment uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare a public.sec_assignments;reports jsonb;weekly jsonb;periods jsonb;
begin
 a:=sec_private.dashboard_assignment(p_assignment);
 if not exists(select 1 from sec_private.dashboard_lineage where assignment_id=a.id) then return null;end if;
 select coalesce(jsonb_agg(to_jsonb(r) order by r.published_at,r.id),'[]'::jsonb) into reports from public.sec_monthly_reports r
 where r.person_id=a.person_id and r.department_id=a.department_id and sec_private.matches_dashboard_source(a.id,r.assignment_id,r.month);
 select coalesce(jsonb_agg(to_jsonb(w) order by w.published_at,w.id),'[]'::jsonb) into weekly from public.sec_weekly_snapshots w
 where w.person_id=a.person_id and w.department_id=a.department_id and sec_private.matches_dashboard_source(a.id,w.assignment_id,w.month);
 select coalesce(jsonb_agg(jsonb_build_object('fromMonth',to_char(r.from_month,'YYYY-MM'),'throughMonth',to_char(r.through_month,'YYYY-MM'),
  'sourceAssignmentId',s.id,'sourceMarket',s.market,'marketAssignmentId',m.id,'market',m.market) order by r.from_month),'[]'::jsonb)
 into periods from sec_private.dashboard_lineage r join public.sec_assignments s on s.id=r.source_assignment_id join public.sec_assignments m on m.id=r.market_assignment_id where r.assignment_id=a.id;
 return jsonb_build_object('reports',reports,'weekly',weekly,'premiumRows',reports,'marketLineage',periods);
end $$;



CREATE OR REPLACE FUNCTION sec_private.own_point_history(p_assignment uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare a public.sec_assignments;result jsonb;
begin
 a:=sec_private.dashboard_assignment(p_assignment);
 if a.department_id='ST' then return '[]'::jsonb;end if;
 select coalesce(jsonb_agg(jsonb_build_object('month',to_char(h.month,'YYYY-MM'),'points',h.points,'sourceLevel',h.source_level)
  ||sec_private.absence_annotation(a.person_id,a.department_id,h.month)||sec_private.level_market_annotation(a.person_id,a.department_id,h.month) order by h.month),'[]'::jsonb)
 into result from sec_private.monthly_point_history(a.department_id,'0001-01-01',date_trunc('month',current_date)::date,a.person_id) h;
 return sec_private.project_participation_start(result,a.person_id,a.department_id);
end $function$;

CREATE OR REPLACE FUNCTION sec_private.own_level_history(p_assignment uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare a public.sec_assignments;result jsonb;
begin
 a:=sec_private.dashboard_assignment(p_assignment);
 if a.department_id='ST' then return '[]'::jsonb;end if;
 with departments as(select distinct s.department_id from public.sec_assignments s where s.person_id=a.person_id and s.archived_at is null and s.department_id<>'ST'),
 histories as(select d.department_id,h.month,h.points,h.source_level from departments d cross join lateral sec_private.monthly_point_history(d.department_id,'0001-01-01',date_trunc('month',current_date)::date,a.person_id) h)
 select coalesce(jsonb_agg(jsonb_build_object('month',to_char(h.month,'YYYY-MM'),'points',h.points,'sourceLevel',h.source_level,'groupId',h.department_id,
  'division',coalesce((select p.department_id from sec_private.person_division_history p where p.person_id=a.person_id and h.month between p.from_month and p.through_month),h.department_id))
  ||sec_private.absence_annotation(a.person_id,h.department_id,h.month)||sec_private.level_market_annotation(a.person_id,h.department_id,h.month) order by h.month,h.department_id),'[]'::jsonb)
 into result from histories h;return sec_private.project_level_starts(result,a.person_id);
end $function$;

CREATE OR REPLACE FUNCTION sec_private.dashboard_history(p_assignment uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare a public.sec_assignments;scope text;points jsonb;levels jsonb;content jsonb;
begin
 a:=sec_private.dashboard_assignment(p_assignment);
 content:=sec_private.lineage_content(a.id);
 select r.history_scope into scope from sec_private.dashboard_history_rules r where r.person_id=a.person_id and r.department_id=a.department_id;
 scope:=coalesce(scope,'division');
 if scope='division' or a.department_id='ST' then
  return jsonb_build_object('historyScope','division','pointHistory',sec_private.own_point_history(a.id),'levelHistory',sec_private.own_level_history(a.id));
 end if;
 -- A separate market never borrows another assignment's points, category, or unscoped evidence.
 with scoped as(
 select to_jsonb(r) as document from public.sec_monthly_reports r where content is null and r.assignment_id=a.id
 union all select v from jsonb_array_elements(coalesce(content->'reports','[]'::jsonb))e(v)
 ),latest as(
 select distinct on((document->>'month')::date)(document->>'month')::date as month,document->'payload' as payload from scoped
 where(document->>'month')::date<=date_trunc('month',current_date)::date
 order by(document->>'month')::date,(document->>'revision')::integer desc
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
  ||sec_private.absence_annotation(a.person_id,a.department_id,t.month)||sec_private.lineage_annotation(a.id,t.month) order by t.month),'[]'::jsonb)
 into points from combined t;
 points:=sec_private.project_participation_start(points,a.person_id,a.department_id);
 select coalesce(jsonb_agg(p.value||jsonb_build_object('groupId',a.department_id,'division',coalesce(
  (select d.department_id from sec_private.person_division_history d where d.person_id=a.person_id and ((p.value->>'month')||'-01')::date between d.from_month and d.through_month),a.department_id)) order by p.value->>'month'),'[]'::jsonb)
 into levels from jsonb_array_elements(points) p(value);
 return jsonb_build_object('historyScope',scope,'pointHistory',points,'levelHistory',levels)||case when content is null then '{}'::jsonb else jsonb_build_object('content',content) end;
end $function$;

CREATE OR REPLACE FUNCTION sec_private.supervisor_dashboard(p_assignment uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare a public.sec_assignments; u public.sec_accounts; reports jsonb; weekly jsonb; assignments jsonb; premium_rows jsonb; receipts jsonb; rankings jsonb; history jsonb; content jsonb;
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
 history:=sec_private.dashboard_history(a.id);content:=history->'content';
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
 if content is not null then reports:=content->'reports';weekly:=content->'weekly';premium_rows:=content->'premiumRows';end if;
 select coalesce(jsonb_agg(jsonb_build_object('report_id',r.report_id)),'[]'::jsonb) into receipts
 from public.sec_read_receipts r join public.sec_monthly_reports m on m.id=r.report_id
 where r.user_id=u.user_id and m.id in(select(v->>'id')::uuid from jsonb_array_elements(reports)e(v));
 select coalesce(jsonb_object_agg(to_char(m.month,'YYYY-MM'),case when history->>'historyScope'='assignment' then jsonb_build_object('pool',0,'rank',null,'outsideTopTen',false,'reason','market-scope') else sec_private.own_rank(a.id,m.month) end),'{}'::jsonb) into rankings
 from(select distinct(v->>'month')::date as month from jsonb_array_elements(reports)e(v))m;
 return jsonb_build_object('subject',jsonb_build_object('person_id',a.person_id,'display_name',coalesce(nullif(btrim(u.display_name),''),(select p.name from public.sec_people p where p.id=a.person_id)),
  'primary_department',u.primary_department,'setting',u.setting),'assignments',assignments,'selectedAssignment',a.id,
  'reports',reports,'weekly',weekly,'pointHistory',history->'pointHistory','levelHistory',history->'levelHistory','historyScope',history->>'historyScope','premiumRows',premium_rows,'read',receipts,'rankings',rankings)||case when content is null then '{}'::jsonb else jsonb_build_object('marketLineage',content->'marketLineage') end;
end $function$;

CREATE OR REPLACE FUNCTION sec_private.closing_comments(p_assignment uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare actor uuid:=sec_private.actor_id(); assignment public.sec_assignments;
begin
 if actor is null or not exists(select 1 from public.sec_accounts a where a.user_id=actor and not a.must_change_password)
 then raise exception 'Active account required' using errcode='42501'; end if;
 if p_assignment is not null then
  select * into assignment from public.sec_assignments where id=p_assignment;
  if assignment.id is null then raise exception 'SEC assignment not permitted' using errcode='42501'; end if;
  if not(assignment.department_id=any(sec_private.department_scope())) then
   assignment:=sec_private.dashboard_assignment(p_assignment);
  end if;
 end if;
 return(select coalesce(jsonb_agg(jsonb_build_object('report_id',c.report_id,'metric_key',c.metric_key,'comments',c.comments) order by c.report_id,c.metric_key),'[]'::jsonb)
  from sec_private.closing_cell_comments c join public.sec_monthly_reports r on r.id=c.report_id
  where case when p_assignment is not null then sec_private.matches_dashboard_source(p_assignment,r.assignment_id,r.month) else r.person_id=sec_private.actor_person() end);
end $function$;

CREATE OR REPLACE FUNCTION sec_private.history_rules(p_person uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare person uuid;settings jsonb;absences jsonb;result jsonb;
begin
 if sec_private.actor_id() is null then raise exception 'Verified account required' using errcode='42501';end if;
 person:=coalesce(p_person,sec_private.actor_person());
 if p_person is not null and not sec_private.is_app_admin() and p_person is distinct from sec_private.actor_person()
 then raise exception 'Own history rules only' using errcode='42501';end if;
 select coalesce(jsonb_agg(jsonb_build_object('department',r.department_id,'scope',r.history_scope,'note',r.note,'updatedAt',r.updated_at) order by r.department_id),'[]'::jsonb)
 into settings from sec_private.dashboard_history_rules r where r.person_id=person;
 select coalesce(jsonb_agg(jsonb_build_object('id',r.id,'department',r.department_id,'from',to_char(r.from_month,'YYYY-MM'),'through',to_char(r.through_month,'YYYY-MM'),'note',r.note,'confirmedAt',r.created_at) order by r.from_month),'[]'::jsonb)
 into absences from sec_private.level_absences r where r.person_id=person;
 result:=jsonb_build_object('settings',settings,'absences',absences,'marketPeriods',
 (select coalesce(jsonb_agg(jsonb_build_object('department',r.department_id,'assignmentId',r.assignment_id,'market',a.market,
 'from',to_char(r.from_month,'YYYY-MM'),'through',to_char(r.through_month,'YYYY-MM'),'note',r.note,'confirmedAt',r.confirmed_at) order by r.from_month),'[]'::jsonb)
 from sec_private.level_market_periods r join public.sec_assignments a on a.id=r.assignment_id where r.person_id=person));
 return result||jsonb_build_object('participationStarts',
 (select coalesce(jsonb_agg(jsonb_build_object('department',r.department_id,'month',to_char(r.first_month,'YYYY-MM'),'note',r.note,'confirmedAt',r.confirmed_at) order by r.department_id),'[]'::jsonb) from sec_private.participation_starts r where r.person_id=person),
 'dashboardLineage',(select coalesce(jsonb_agg(jsonb_build_object('assignmentId',r.assignment_id,'sourceAssignmentId',r.source_assignment_id,'marketAssignmentId',r.market_assignment_id,
 'from',to_char(r.from_month,'YYYY-MM'),'through',to_char(r.through_month,'YYYY-MM'),'note',r.note,'confirmedAt',r.confirmed_at) order by r.assignment_id,r.from_month),'[]'::jsonb)
 from sec_private.dashboard_lineage r join public.sec_assignments a on a.id=r.assignment_id where a.person_id=person));

end $function$;

CREATE OR REPLACE FUNCTION sec_private.set_dashboard_history_rule(p_person uuid, p_department text, p_scope text, p_note text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare old_rule sec_private.dashboard_history_rules;
begin
 if not sec_private.is_app_admin() then raise exception 'Verified app administrator required' using errcode='42501';end if;
 if p_person is null or p_department is null or p_scope is null or p_scope not in('division','assignment')
  or p_department not in('HE','DA','IM','LH') or not p_department=any(sec_private.department_scope())
  or not exists(select 1 from public.sec_assignments a where a.person_id=p_person and a.department_id=p_department and a.archived_at is null)
  or p_note is null or length(btrim(p_note)) not between 1 and 1000 then raise exception 'Invalid history rule' using errcode='22023';end if;
 perform pg_advisory_xact_lock(hashtext('sec_history_rule:'||p_person::text||':'||p_department));
 if p_scope='division' and exists(select 1 from sec_private.dashboard_lineage l join public.sec_assignments a on a.id=l.assignment_id where a.person_id=p_person and a.department_id=p_department)
 then raise exception 'Confirmed dashboard lineage requires separate-market scope' using errcode='22023';end if;

 if p_scope='assignment' and exists(select 1 from sec_private.level_market_periods where person_id=p_person and department_id=p_department)
 then raise exception 'Confirmed transitions use division history; review before changing scope' using errcode='22023';end if;
 select * into old_rule from sec_private.dashboard_history_rules where person_id=p_person and department_id=p_department;
 if old_rule.history_scope=p_scope and old_rule.note=btrim(p_note) then return jsonb_build_object('changed',false,'scope',p_scope);end if;
 insert into sec_private.dashboard_history_rules(person_id,department_id,history_scope,note,confirmed_by)
 values(p_person,p_department,p_scope,btrim(p_note),sec_private.actor_id())
 on conflict(person_id,department_id) do update set history_scope=excluded.history_scope,note=excluded.note,confirmed_by=excluded.confirmed_by,updated_at=now();
 perform sec_private.audit(p_department,'history.scope_confirmed','person',p_person,jsonb_build_object('from',coalesce(old_rule.history_scope,'division'),'through',p_scope));
 return jsonb_build_object('changed',true,'scope',p_scope);
end $function$;


revoke all on function sec_private.project_participation_start(jsonb,uuid,text),sec_private.project_level_starts(jsonb,uuid),
 sec_private.matches_dashboard_source(uuid,uuid,date),sec_private.lineage_annotation(uuid,date),sec_private.lineage_content(uuid) from public,anon,authenticated,service_role;
revoke all on function sec_private.set_participation_start(uuid,text,date,text),public.sec_set_participation_start(uuid,text,date,text),
 sec_private.set_dashboard_lineage(uuid,jsonb,text),public.sec_set_dashboard_lineage(uuid,jsonb,text) from public,anon,authenticated,service_role;
grant execute on function sec_private.set_participation_start(uuid,text,date,text),public.sec_set_participation_start(uuid,text,date,text),
 sec_private.set_dashboard_lineage(uuid,jsonb,text),public.sec_set_dashboard_lineage(uuid,jsonb,text) to authenticated;
notify pgrst,'reload schema';
