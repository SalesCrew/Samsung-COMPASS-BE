-- Keep presentation data virtual and separate from real employee reports.
alter table sec_private.presentation_accounts
 add column department_id text not null default 'IM'
 constraint presentation_department_supported check (department_id in ('IM','HE'));

create or replace function sec_private.own_presentation() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
 if sec_private.actor_id() is null then raise exception 'Live session required' using errcode='42501';end if;
 select jsonb_build_object('personId',p.person_id,'assignmentId',p.assignment_id,'market',p.market,'readIds',p.read_ids)
 into result from sec_private.presentation_accounts p join public.sec_accounts a on a.user_id=p.user_id
 where p.user_id=sec_private.actor_id() and a.role='sec' and a.is_test and not a.must_change_password
 and a.primary_department=p.department_id and a.person_id is null;
 return result;
end $$;

create or replace function sec_private.guard_presentation_account() returns trigger
language plpgsql security definer set search_path='' as $$
declare presentation_department text;
begin
 select p.department_id into presentation_department from sec_private.presentation_accounts p where p.user_id=new.user_id;
 if found and (new.person_id is not null or new.role<>'sec' or not new.is_test
 or new.primary_department is distinct from presentation_department)
 then raise exception 'Presentation account must remain isolated' using errcode='42501';end if;
 return new;
end $$;
-- Existing fixed search paths, table RLS and revoked/granted permissions remain intact.
notify pgrst,'reload schema';
