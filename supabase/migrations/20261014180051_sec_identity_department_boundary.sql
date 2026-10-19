create function sec_private.actor_department() returns text language sql stable security definer set search_path='' as $$
 select primary_department from public.sec_accounts where user_id=sec_private.actor_id() and not must_change_password
$$;
revoke all on function sec_private.actor_department() from public,anon;
grant execute on function sec_private.actor_department() to authenticated;
alter policy sec_assignments_read on public.sec_assignments
 using((person_id=(select sec_private.actor_person()) and department_id=(select sec_private.actor_department()))
 or department_id=any((select sec_private.department_scope())::text[]));
alter policy sec_monthly_read on public.sec_monthly_reports
 using((person_id=(select sec_private.actor_person()) and department_id=(select sec_private.actor_department()))
 or department_id=any((select sec_private.department_scope())::text[]));
alter policy sec_weekly_read on public.sec_weekly_snapshots
 using((person_id=(select sec_private.actor_person()) and department_id=(select sec_private.actor_department()))
 or department_id=any((select sec_private.department_scope())::text[]));
create or replace function sec_private.stage_import(p_department text,p_month date,p_phase text,p_as_of date,p_fingerprint text,p_filename text,p_sheet text,p_mapping jsonb,p_config uuid,p_rows jsonb) returns public.sec_imports
 language plpgsql security definer set search_path='' as $$
declare result public.sec_imports; item jsonb; person uuid; assignment uuid; count_rows integer:=0;
 normalized jsonb; row_setting text; existing_name text; source_external_id text;
begin
 if not p_department=any(sec_private.department_scope()) then raise exception 'Department not permitted' using errcode='42501'; end if;
 if p_as_of > (now() at time zone 'Europe/Vienna')::date then raise exception 'Future stands cannot be staged'; end if;
 if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows) not between 1 and 20000 then raise exception 'Invalid import rows'; end if;
 if p_config is not null and not exists(select 1 from public.sec_config_versions where id=p_config and department_id=p_department)
 then raise exception 'Configuration outside department'; end if;
 perform pg_advisory_xact_lock(hashtext('sec_import:'||p_department||':'||p_month::text));
 select * into result from public.sec_imports where department_id=p_department and month=p_month and phase=p_phase and fingerprint=p_fingerprint;
 if result.id is not null then return result; end if;
 insert into public.sec_imports(department_id,month,phase,as_of,fingerprint,filename,sheet,mapping,config_id,created_by)
 values(p_department,p_month,p_phase,p_as_of,p_fingerprint,p_filename,p_sheet,p_mapping,p_config,sec_private.actor_id()) returning * into result;
 for item in select value from jsonb_array_elements(p_rows)
 loop
   normalized:=item->'normalized'; row_setting:=coalesce(normalized->>'setting','full'); source_external_id:=btrim(item->>'externalId');
   if normalized->>'groupId' is distinct from p_department or normalized->>'month' is distinct from to_char(p_month,'YYYY-MM')
    or jsonb_typeof(normalized->'metrics') is distinct from 'array' or source_external_id is null or source_external_id=''
    or jsonb_typeof(item->'fields') is distinct from 'object'
   then raise exception 'Invalid normalized row or context'; end if;
   if (item->'fields') ?| array['premium.salary','assignment.comment','attendance.reason','attendance.code']
   then raise exception 'Unnecessary HR fields are not accepted'; end if;
   select id into person from public.sec_people where external_id=source_external_id;
   if person is not null and not sec_private.is_app_admin()
    and not exists(select 1 from public.sec_assignments where person_id=person and department_id=any(sec_private.department_scope()))
   then raise exception 'Existing identity outside department scope' using errcode='42501'; end if;
   insert into public.sec_people(external_id,name) values(source_external_id,coalesce(item->>'name',''))
    on conflict (external_id) do nothing;
   select id,name into person,existing_name from public.sec_people where sec_people.external_id=source_external_id;
   if existing_name<>coalesce(item->>'name','') and length(coalesce(item->>'name',''))>0 then
     if sec_private.is_app_admin() or exists(select 1 from public.sec_assignments where person_id=person and department_id=any(sec_private.department_scope()))
     then update public.sec_people set name=item->>'name' where id=person; end if;
   end if;
   insert into public.sec_assignments(person_id,department_id,setting,market,source_shop_id)
    values(person,p_department,row_setting,btrim(item->>'market'),nullif(item->>'sourceShopId',''))
    on conflict(person_id,department_id,setting,market) do nothing;
   select id into assignment from public.sec_assignments where person_id=person and department_id=p_department and setting=row_setting and market=btrim(item->>'market');
   insert into public.sec_import_rows(import_id,person_id,assignment_id,source_row,fields,normalized)
    values(result.id,person,assignment,(item->>'row')::integer,item->'fields',normalized);
   count_rows:=count_rows+1;
 end loop;
 update public.sec_imports set row_count=count_rows where id=result.id returning * into result;
 perform sec_private.audit(p_department,'import.staged','import',result.id,jsonb_build_object('phase',p_phase,'rows',count_rows));
 return result;
end $$;
