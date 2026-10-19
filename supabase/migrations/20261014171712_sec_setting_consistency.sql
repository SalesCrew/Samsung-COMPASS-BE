create or replace function sec_private.manage_account(p_user_id uuid,p_profile jsonb) returns public.sec_accounts
 language plpgsql security definer set search_path='' as $$
declare old public.sec_accounts; result public.sec_accounts; allowed text[];
 requested_role text; departments text[]; requested_person uuid; is_root boolean; next_department text; next_setting text;
begin
 allowed:=sec_private.department_scope(); is_root:=sec_private.is_app_admin();
 if sec_private.actor_id() is null or cardinality(allowed)=0 then raise exception 'Administrator access required' using errcode='42501'; end if;
 perform pg_advisory_xact_lock(hashtext('sec_account_management'));
 select * into old from public.sec_accounts where user_id=p_user_id for update;
 requested_role:=coalesce(p_profile->>'role',old.role,'sec');
 select coalesce(array_agg(value),'{}'::text[]) into departments from jsonb_array_elements_text(coalesce(p_profile->'department_ids',to_jsonb(old.department_ids),'[]'));
 if not is_root and (requested_role<>'sec' or old.role in ('app_admin','department_admin')
   or not departments <@ allowed or (old.user_id is not null and not old.department_ids <@ allowed))
 then raise exception 'Account outside department scope' using errcode='42501'; end if;
 next_department:=case when p_profile ? 'primary_department' then nullif(p_profile->>'primary_department','') else old.primary_department end;
 next_setting:=case when next_department='DA' then coalesce(p_profile->>'setting',old.setting,'full') else 'full' end;
 requested_person:=case when p_profile ? 'person_id' then nullif(p_profile->>'person_id','')::uuid else old.person_id end;
 if requested_person is not null and not is_root and not exists(select 1 from public.sec_assignments where person_id=requested_person and department_id=any(allowed))
 then raise exception 'Person outside department scope' using errcode='42501'; end if;
 if old.role='app_admin' and old.active and
   (requested_role<>'app_admin' or p_profile->>'active'='false')
   and (select count(*) from public.sec_accounts where role='app_admin' and active)<=1
 then raise exception 'The last active app administrator must remain enabled'; end if;
 if old.user_id is null then
   insert into public.sec_accounts(user_id,email,display_name,role,department_ids,person_id,primary_department,setting,must_change_password,is_test)
   select u.id,u.email,coalesce(p_profile->>'display_name',''),requested_role,departments,requested_person,
    next_department,next_setting,true,false
   from auth.users u where u.id=p_user_id and u.email_confirmed_at is not null
   returning * into result;
   if result.user_id is null then raise exception 'Verified Auth account not found'; end if;
 else
   update public.sec_accounts set display_name=coalesce(p_profile->>'display_name',display_name),
    role=requested_role,department_ids=departments,person_id=requested_person,
    primary_department=next_department,
    setting=next_setting,
    active=coalesce((p_profile->>'active')::boolean,active),updated_at=now()
   where user_id=p_user_id returning * into result;
 end if;
 if not result.active then delete from auth.sessions where user_id=p_user_id; end if;
 perform sec_private.audit(case when is_root then null else departments[1] end,'account.updated','account',p_user_id,
   jsonb_build_object('role',result.role,'departments',result.department_ids,'active',result.active,'linked',result.person_id is not null));
 return result;
end $$;

alter table public.sec_assignments add constraint sec_assignment_da_setting check(department_id='DA' or setting='full');
alter table public.sec_config_versions add constraint sec_config_da_setting check(department_id='DA' or setting='full');
alter table public.sec_accounts add constraint sec_account_da_setting check(role<>'sec' or primary_department='DA' or setting='full');
