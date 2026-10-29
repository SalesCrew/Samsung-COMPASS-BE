-- One point value per person/division/month, even after a change of market or DA setting.
-- Conflicting or missing source values remain unknown; published rows are never rewritten.
create or replace function sec_private.monthly_point_history(p_department text,p_from date,p_through date,p_person uuid default null)
returns table(person_id uuid,month date,points numeric,source_level text)
language sql stable security invoker set search_path='' as $$
 with active as (
  select distinct on(r.person_id,r.assignment_id,r.month) r.person_id,r.month,r.payload
  from public.sec_monthly_reports r
  where r.department_id=p_department and r.month between p_from and p_through
   and (p_person is null or r.person_id=p_person)
  order by r.person_id,r.assignment_id,r.month,r.revision desc
 ), typed as (
  select a.person_id,a.month,
   case when jsonb_typeof(a.payload->'points')='number' then
    case when (a.payload->>'points')::numeric between 0 and 3 then (a.payload->>'points')::numeric end end as value,
   case upper(regexp_replace(coalesce(a.payload->>'sourceLevel',''),'\s','','g'))
    when 'SEC' then 'SEC' when 'SEC+' then 'SEC+' when 'SECPRO' then 'SEC Pro' end as level
  from active a
 )
 select t.person_id,t.month,
  case when count(t.value)=count(*) and min(t.value)=max(t.value) then max(t.value) end,
  case when count(distinct t.level)=1 then max(t.level) end
 from typed t group by t.person_id,t.month
$$;
revoke all on function sec_private.monthly_point_history(text,date,date,uuid) from public,anon,authenticated,service_role;

create or replace function sec_private.own_point_history(p_assignment uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare a public.sec_assignments; result jsonb;
begin
 select s.* into a from public.sec_assignments s join public.sec_accounts u on u.user_id=sec_private.actor_id()
 where s.id=p_assignment and s.person_id=sec_private.actor_person()
  and s.department_id=u.primary_department and (s.department_id<>'DA' or s.setting=u.setting);
 if a.id is null then raise exception 'Own current division assignment required' using errcode='42501'; end if;
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
 select s.* into a from public.sec_assignments s join public.sec_accounts u on u.user_id=sec_private.actor_id()
 where s.id=p_assignment and s.person_id=sec_private.actor_person()
  and s.department_id=u.primary_department and (s.department_id<>'DA' or s.setting=u.setting);
 if a.id is null then raise exception 'Own current division assignment required' using errcode='42501'; end if;
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
notify pgrst,'reload schema';
