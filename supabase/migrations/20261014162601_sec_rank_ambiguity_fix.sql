create or replace function sec_private.own_rank(p_assignment uuid,p_month date) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare a public.sec_assignments; pool integer; own_points numeric; place integer; all_complete boolean;
begin
 select * into a from public.sec_assignments where id=p_assignment and person_id=sec_private.actor_person();
 if auth.uid() is null or sec_private.actor_id() is null or a.id is null then raise exception 'Own assignment required' using errcode='42501'; end if;
 if a.department_id in ('ST','LH') or p_month is null or extract(day from p_month)<>1 then return jsonb_build_object('pool',0,'rank',null,'outsideTopTen',false); end if;
 with current as (
  select distinct on (r.assignment_id,r.month) r.* from public.sec_monthly_reports r join public.sec_assignments s on s.id=r.assignment_id
  where s.department_id=a.department_id and s.setting=a.setting and r.month between date_trunc('year',p_month)::date and p_month
  order by r.assignment_id,r.month,r.revision desc
 ), eligible as (
  select assignment_id,sum((payload->>'points')::numeric) points,
   count(*)=extract(month from p_month)::integer and count(payload->>'points')=count(*) as complete
  from current where assignment_id in (select assignment_id from current where month=p_month)
  group by assignment_id
 )
 select count(*),max(points) filter(where assignment_id=p_assignment),coalesce(bool_and(complete),false)
 into pool,own_points,all_complete from eligible;
 if pool<10 or not all_complete or own_points is null then return jsonb_build_object('pool',0,'rank',null,'outsideTopTen',false); end if;
 with current as (
  select distinct on (r.assignment_id,r.month) r.* from public.sec_monthly_reports r join public.sec_assignments s on s.id=r.assignment_id
  where s.department_id=a.department_id and s.setting=a.setting and r.month between date_trunc('year',p_month)::date and p_month
  order by r.assignment_id,r.month,r.revision desc
 ), totals as (
  select assignment_id,sum((payload->>'points')::numeric) points from current
  where assignment_id in (select assignment_id from current where month=p_month) group by assignment_id
 )
 select 1+count(*) into place from totals where points>own_points;
 return jsonb_build_object('pool',pool,'rank',case when place<=10 then place else null end,'outsideTopTen',place>10);
end $$;
