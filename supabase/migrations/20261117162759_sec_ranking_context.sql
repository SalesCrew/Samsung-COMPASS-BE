-- Explain the historical closing cohort without exposing another person's identity,
-- points or rank. The established rolling ranking and own-only guards stay intact.
create or replace function sec_private.own_rank(p_assignment uuid,p_month date) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare a public.sec_assignments; pool integer; own_points numeric; place integer; coverage jsonb;
begin
 a:=sec_private.dashboard_assignment(p_assignment);
 if a.department_id='ST' or p_month is null or extract(day from p_month)<>1
  or p_month>date_trunc('month',current_date)::date then
  return jsonb_build_object('pool',0,'rank',null,'outsideTopTen',false,'reason','unavailable');
 end if;
 with history as materialized (
  select * from sec_private.monthly_point_history(a.department_id,(p_month-interval '11 months')::date,p_month)
 ), totals as (
  select h.person_id,count(*) as months,count(h.points) as known,sum(h.points) as points,
   bool_or(h.month=p_month) as in_closing
  from history h group by h.person_id
 ), comparable as (
  select * from totals where months=12 and known=12
 )
 select count(*),max(t.points) filter(where t.person_id=a.person_id),
  (1+count(*) filter(where t.points>(select own.points from comparable own where own.person_id=a.person_id)))::integer,
  jsonb_build_object(
   'fromMonth',to_char((p_month-interval '11 months')::date,'YYYY-MM'),
   'throughMonth',to_char(p_month,'YYYY-MM'),
   'total',(select count(*) from totals where in_closing),
   'comparable',count(*),
   'missingMonths',(select count(*) from totals where in_closing and months<12),
   'unclearPoints',(select count(*) from totals where in_closing and months=12 and known<12))
 into pool,own_points,place,coverage from comparable t;
 -- Preserve the existing small-cohort privacy threshold.
 if pool<10 then coverage:=null; end if;
 if own_points is null then
  return jsonb_build_object('pool',0,'rank',null,'outsideTopTen',false,'reason','incomplete-history')||
   case when coverage is null then '{}'::jsonb else jsonb_build_object('coverage',coverage) end;
 end if;
 if pool<10 then
  return jsonb_build_object('pool',0,'rank',null,'outsideTopTen',false,'reason','not-enough-participants');
 end if;
 return jsonb_build_object('pool',pool,'rank',case when place<=10 then place else null end,'outsideTopTen',place>10,'coverage',coverage);
end $$;
revoke all on function sec_private.own_rank(uuid,date),public.sec_own_rank(uuid,date) from public,anon,authenticated,service_role;
grant execute on function sec_private.own_rank(uuid,date),public.sec_own_rank(uuid,date) to authenticated;
notify pgrst,'reload schema';
