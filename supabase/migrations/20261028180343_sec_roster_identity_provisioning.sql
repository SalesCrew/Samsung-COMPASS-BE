-- Create a roster-confirmed identity/assignment without fabricating a report.
-- Business writes retain the same verified app-admin/session boundary as imports.
create or replace function sec_private.provision_roster_person(
 p_external_id text,p_name text,p_department text,p_setting text,p_market text,
 p_source_hash text,p_source_row integer
) returns jsonb
language plpgsql security definer set search_path='' as $$
declare person public.sec_people; assignment public.sec_assignments;
 person_created boolean; assignment_created boolean; affected integer;
begin
 if sec_private.actor_id() is null or not sec_private.is_app_admin()
 then raise exception 'Verified app administrator required' using errcode='42501'; end if;
 if p_external_id is null or length(btrim(p_external_id)) not between 1 and 120
 or p_name is null or length(btrim(p_name)) not between 1 and 200
 or p_market is null or length(btrim(p_market)) not between 1 and 300
 or p_department is null or p_department not in ('DA','HE','IM','LH','ST')
 or p_setting is null or p_setting not in ('full','laundry-ref','vc')
 or (p_department<>'DA' and p_setting<>'full')
 or p_source_hash is null or p_source_hash !~ '^[a-f0-9]{64}$'
 or p_source_row is null or p_source_row not between 2 and 100000
 then raise exception 'Invalid roster identity or provenance'; end if;
 perform pg_advisory_xact_lock(hashtext('sec_roster:'||btrim(p_external_id)));
 insert into public.sec_people(external_id,name) values(btrim(p_external_id),btrim(p_name))
 on conflict(external_id) do nothing;
 get diagnostics affected=row_count; person_created:=affected=1;
 select * into person from public.sec_people where external_id=btrim(p_external_id);
 if person.name is distinct from btrim(p_name)
 then raise exception 'Canonical identity name conflict'; end if;
 insert into public.sec_assignments(person_id,department_id,setting,market,source_shop_id)
 values(person.id,p_department,p_setting,btrim(p_market),null)
 on conflict(person_id,department_id,setting,market) do nothing;
 get diagnostics affected=row_count; assignment_created:=affected=1;
 select * into assignment from public.sec_assignments
 where person_id=person.id and department_id=p_department and setting=p_setting and market=btrim(p_market);
 if person_created or assignment_created then
  perform sec_private.audit(p_department,'identity.roster_provisioned','person',person.id,
   jsonb_build_object('source_sha256',p_source_hash,'source_row',p_source_row,
    'person_created',person_created,'assignment_created',assignment_created,'no_report_created',true));
 end if;
 return jsonb_build_object('person',to_jsonb(person),'assignment',to_jsonb(assignment),
  'personCreated',person_created,'assignmentCreated',assignment_created);
end $$;
create or replace function public.sec_provision_roster_person(
 p_external_id text,p_name text,p_department text,p_setting text,p_market text,
 p_source_hash text,p_source_row integer
) returns jsonb language sql security invoker set search_path='' as $$
 select sec_private.provision_roster_person(p_external_id,p_name,p_department,p_setting,p_market,p_source_hash,p_source_row)
$$;
revoke all on function sec_private.provision_roster_person(text,text,text,text,text,text,integer) from public,anon,authenticated,service_role;
revoke all on function public.sec_provision_roster_person(text,text,text,text,text,text,integer) from public,anon,authenticated,service_role;
grant execute on function sec_private.provision_roster_person(text,text,text,text,text,text,integer) to authenticated;
grant execute on function public.sec_provision_roster_person(text,text,text,text,text,text,integer) to authenticated;
notify pgrst,'reload schema';
