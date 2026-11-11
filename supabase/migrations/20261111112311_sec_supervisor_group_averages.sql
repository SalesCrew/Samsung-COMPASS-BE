-- Published group inputs only; supervisor identity/session/initial-password checks
-- are the same as the individual read-only view. No table policies are widened.
create function sec_private.supervisor_group_source(p_department text) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare members jsonb;reports jsonb;weekly jsonb;premiums jsonb;points jsonb;
begin
 if not sec_private.is_supervisor() then raise exception 'Supervisor access required' using errcode='42501';end if;
 if p_department is null or p_department<>all(array['HE','DA','IM','LH','ST']) then raise exception 'Invalid division' using errcode='22023';end if;
 select coalesce(jsonb_agg(jsonb_build_object('person_id',u.person_id,'setting',u.setting)),'[]'::jsonb) into members
 from public.sec_accounts u where u.role='sec' and u.active and not u.is_test and u.person_id is not null and u.primary_department=p_department
 and exists(select 1 from public.sec_assignments a where a.person_id=u.person_id and a.department_id=p_department and (p_department<>'DA' or a.setting=u.setting));
 select coalesce(jsonb_agg(to_jsonb(r)),'[]'::jsonb) into reports from public.sec_monthly_reports r
 join public.sec_assignments a on a.id=r.assignment_id
 join public.sec_accounts u on u.person_id=a.person_id and u.primary_department=a.department_id
 where a.department_id=p_department and (p_department<>'DA' or a.setting=u.setting) and u.role='sec' and u.active and not u.is_test;
 select coalesce(jsonb_agg(to_jsonb(w)),'[]'::jsonb) into weekly from public.sec_weekly_snapshots w
 join public.sec_assignments a on a.id=w.assignment_id
 join public.sec_accounts u on u.person_id=a.person_id and u.primary_department=a.department_id
 where a.department_id=p_department and (p_department<>'DA' or a.setting=u.setting) and u.role='sec' and u.active and not u.is_test;
 select coalesce(jsonb_agg(jsonb_build_object('id',r.id,'person_id',r.person_id,'assignment_id',r.assignment_id,
  'department_id',r.department_id,'month',r.month,'revision',r.revision,'payload',r.payload-'metrics'-'qualitative'-'changed')),'[]'::jsonb)
 into premiums from public.sec_monthly_reports r where r.department_id=p_department and exists(
  select 1 from jsonb_array_elements(members) m where (m->>'person_id')::uuid=r.person_id);
 select coalesce(jsonb_agg(jsonb_build_object('person_id',u.person_id,'history',sec_private.own_point_history(a.id))),'[]'::jsonb) into points
 from public.sec_accounts u join lateral (select s.id from public.sec_assignments s where s.person_id=u.person_id and s.department_id=u.primary_department
  and (s.department_id<>'DA' or s.setting=u.setting) order by s.created_at,s.id limit 1) a on true
 where u.role='sec' and u.active and not u.is_test and u.primary_department=p_department;
 return jsonb_build_object('members',members,'reports',reports,'weekly',weekly,'premiumRows',premiums,'pointHistory',points);
end $$;
create function public.sec_supervisor_group_source(p_department text) returns jsonb
language sql stable security invoker set search_path='' as $$ select sec_private.supervisor_group_source(p_department) $$;
revoke all on function sec_private.supervisor_group_source(text),public.sec_supervisor_group_source(text) from public,anon,authenticated,service_role;
grant execute on function sec_private.supervisor_group_source(text),public.sec_supervisor_group_source(text) to authenticated;
notify pgrst,'reload schema';
