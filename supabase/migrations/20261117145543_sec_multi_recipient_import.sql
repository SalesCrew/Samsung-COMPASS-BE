-- Multi-recipient weekly markets and source-separated Lighthouse components. No RLS expansion.
create or replace function sec_private.stage_import(p_department text,p_month date,p_phase text,p_as_of date,p_fingerprint text,p_filename text,p_sheet text,p_mapping jsonb,p_config uuid,p_rows jsonb) returns public.sec_imports
 language plpgsql security definer set search_path='' as $$
declare result public.sec_imports; item jsonb; person uuid; assignment uuid; count_rows integer:=0;
 normalized jsonb; row_setting text; existing_name text; source_external_id text; target_department text;
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
   normalized:=item->'normalized'; target_department:=normalized->>'groupId'; row_setting:=coalesce(normalized->>'setting','full'); source_external_id:=btrim(item->>'externalId');
   if target_department is null or normalized->>'month' is distinct from to_char(p_month,'YYYY-MM')
    or jsonb_typeof(normalized->'metrics') is distinct from 'array' or source_external_id is null or source_external_id=''
    or jsonb_typeof(item->'fields') is distinct from 'object'
   then raise exception 'Invalid normalized row or context'; end if;
   if target_department is distinct from p_department then
    if not target_department=any(sec_private.department_scope()) then raise exception 'Recipient department not permitted' using errcode='42501'; end if;
    if target_department<>'LH' or p_department not in ('HE','IM') or p_phase='MONTH_FINALIZATION'
     or normalized->>'sourceGroup' is distinct from p_department or row_setting<>'full'
     or normalized ?| array['premium','extras','points','softbonus','qualitative','sellout']
     or exists(select 1 from jsonb_array_elements(normalized->'metrics') m where coalesce(m->>'key','') not like lower(p_department)||'-%')
     or exists(select 1 from jsonb_object_keys(item->'fields') k where k like 'person.%' or k like 'premium.%' or k like 'softbonus.%')
    then raise exception 'Invalid Lighthouse source projection'; end if;
    if not exists(select 1 from public.sec_people p join public.sec_assignments a on a.person_id=p.id
      join public.sec_roster_entries r on r.person_id=p.id and r.department_id='LH'
      where p.external_id=source_external_id and a.department_id='LH' and a.setting='full' and a.market=btrim(item->>'market')
       and r.source_month=(select max(q.source_month) from public.sec_roster_entries q where q.department_id='LH' and q.source_month<=to_char(p_month,'YYYY-MM'))
       and r.imported_at=(select max(q.imported_at) from public.sec_roster_entries q where q.department_id='LH' and q.source_month=r.source_month))
    then raise exception 'Unverified Lighthouse recipient' using errcode='42501'; end if;
   elsif normalized ? 'sourceGroup' then raise exception 'Source component only allowed for Lighthouse projection';
   end if;
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
    values(person,target_department,row_setting,btrim(item->>'market'),nullif(item->>'sourceShopId',''))
    on conflict(person_id,department_id,setting,market) do nothing;
   select id into assignment from public.sec_assignments where person_id=person and department_id=target_department and setting=row_setting and market=btrim(item->>'market');
   insert into public.sec_import_rows(import_id,person_id,assignment_id,source_row,fields,normalized)
    values(result.id,person,assignment,(item->>'row')::integer,item->'fields',normalized);
   count_rows:=count_rows+1;
 end loop;
 update public.sec_imports set row_count=count_rows where id=result.id returning * into result;
 perform sec_private.audit(p_department,'import.staged','import',result.id,jsonb_build_object('phase',p_phase,'rows',count_rows));
 return result;
end $$;

create or replace function sec_private.publish_import(p_import uuid) returns public.sec_imports
 language plpgsql security definer set search_path='' as $$
declare batch public.sec_imports; r public.sec_import_rows; n integer; target_department text;
begin
 select * into batch from public.sec_imports where id=p_import for update;
 if batch.id is null or not batch.department_id=any(sec_private.department_scope())
 then raise exception 'Import not permitted' using errcode='42501'; end if;
 if batch.status='published' then return batch; end if;
 if batch.status<>'draft' or batch.row_count=0 then raise exception 'Only a validated nonempty draft can be published'; end if;
 if batch.as_of > (now() at time zone 'Europe/Vienna')::date then raise exception 'Future publication not permitted'; end if;
 perform pg_advisory_xact_lock(hashtext('sec_publication:'||batch.department_id||':'||batch.month::text));
 if exists(select 1 from public.sec_import_rows component join public.sec_assignments a on a.id=component.assignment_id where component.import_id=p_import and a.department_id='LH')
 then perform pg_advisory_xact_lock(hashtext('sec_publication:LH:'||batch.month::text)); end if;
 for r in select * from public.sec_import_rows where import_id=p_import
 loop
   select department_id into target_department from public.sec_assignments where id=r.assignment_id and person_id=r.person_id;
   if target_department is null or not target_department=any(sec_private.department_scope()) then raise exception 'Recipient department not permitted' using errcode='42501'; end if;
   if r.normalized->>'groupId' is distinct from target_department then raise exception 'Recipient context conflict'; end if;
   if batch.phase='MONTH_FINALIZATION' then
    select coalesce(max(revision),0)+1 into n from public.sec_monthly_reports where person_id=r.person_id and assignment_id=r.assignment_id and month=batch.month;
    insert into public.sec_monthly_reports(person_id,assignment_id,department_id,month,revision,import_id,configuration_id,payload)
     values(r.person_id,r.assignment_id,target_department,batch.month,n,p_import,batch.config_id,r.normalized);
   else
    select coalesce(max(revision),0)+1 into n from public.sec_weekly_snapshots where person_id=r.person_id and assignment_id=r.assignment_id and month=batch.month and as_of=batch.as_of;
    insert into public.sec_weekly_snapshots(person_id,assignment_id,department_id,month,as_of,revision,import_id,payload)
     values(r.person_id,r.assignment_id,target_department,batch.month,batch.as_of,n,p_import,r.normalized);
   end if;
 end loop;
 update public.sec_imports set status='published',published_at=now(),published_by=sec_private.actor_id() where id=p_import returning * into batch;
 perform sec_private.audit(batch.department_id,'import.published','import',p_import,jsonb_build_object('phase',batch.phase,'rows',batch.row_count));
 return batch;
end $$;
