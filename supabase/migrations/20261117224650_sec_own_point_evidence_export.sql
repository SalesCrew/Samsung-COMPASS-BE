-- Own-data portability for point-only originals, without exposing the private table.
create function sec_private.own_point_evidence() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare person uuid;result jsonb;
begin
 select a.person_id into person from public.sec_accounts a
 where a.user_id=sec_private.actor_id() and a.active and not a.must_change_password;
 if not found then raise exception 'Active password-unlocked account required' using errcode='42501';end if;
 if person is null then return '[]'::jsonb;end if;
 select coalesce(jsonb_agg(jsonb_build_object('department',e.department_id,'month',to_char(e.month,'YYYY-MM'),
  'points',e.points,'sourceMonth',to_char(e.source_month,'YYYY-MM'),'sourceFile',e.source_file,
  'sourceSha256',e.source_sha256,'sourcePage',e.source_page) order by e.department_id,e.month,e.source_sha256),'[]'::jsonb)
 into result from sec_private.historical_point_evidence e where e.person_id=person;
 return result;
end $$;
create function public.sec_own_point_evidence() returns jsonb
language sql stable security invoker set search_path='' as $$select sec_private.own_point_evidence()$$;
revoke all on function sec_private.own_point_evidence(),public.sec_own_point_evidence() from public,anon,authenticated,service_role;
grant execute on function sec_private.own_point_evidence(),public.sec_own_point_evidence() to authenticated;
notify pgrst,'reload schema';
