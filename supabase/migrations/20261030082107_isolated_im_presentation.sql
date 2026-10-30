-- Presentation records never enter people, assignments, imports, reports or ranking inputs.
create table sec_private.presentation_accounts (
 user_id uuid primary key references public.sec_accounts(user_id) on delete cascade,
 person_id uuid not null default gen_random_uuid(),
 assignment_id uuid not null default gen_random_uuid(),
 market text not null default 'Media Markt Mustermann',
 read_ids text[] not null default '{}',
 created_at timestamptz not null default now()
);
alter table sec_private.presentation_accounts enable row level security;
revoke all on sec_private.presentation_accounts from public,anon,authenticated,service_role;

create function sec_private.own_presentation() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
 if sec_private.actor_id() is null then raise exception 'Live session required' using errcode='42501';end if;
 select jsonb_build_object('personId',p.person_id,'assignmentId',p.assignment_id,'market',p.market,'readIds',p.read_ids)
 into result from sec_private.presentation_accounts p join public.sec_accounts a on a.user_id=p.user_id
 where p.user_id=sec_private.actor_id() and a.role='sec' and a.is_test and not a.must_change_password
 and a.primary_department='IM' and a.person_id is null;
 return result;
end $$;
create function public.sec_own_presentation() returns jsonb
language sql stable security invoker set search_path='' as $$select sec_private.own_presentation()$$;

create function sec_private.read_presentation(p_report text) returns boolean
language plpgsql security definer set search_path='' as $$
declare own jsonb; prefix text; month_text text; through_month date;
begin
 own:=sec_private.own_presentation();if own is null then return false;end if;
 prefix:='presentation-'||(own->>'assignmentId')||'-';
 month_text:=substr(p_report,length(prefix)+1);
 through_month:=(date_trunc('month',timezone('Europe/Vienna',now()))-case when extract(day from timezone('Europe/Vienna',now()))>=15 then interval '1 month' else interval '2 months' end)::date;
 if p_report is null or left(p_report,length(prefix))<>prefix or month_text!~'^[0-9]{4}-(0[1-9]|1[0-2])$'
 then raise exception 'Own presentation report required' using errcode='42501';end if;
 if (month_text||'-01')::date not between (through_month-interval '23 months')::date and through_month
 then raise exception 'Presentation report outside available history' using errcode='42501';end if;
 update sec_private.presentation_accounts set read_ids=array(select distinct x from unnest(array_append(read_ids,p_report)) x where x>=prefix||to_char(through_month-interval '23 months','YYYY-MM'))
 where user_id=sec_private.actor_id();
 return true;
end $$;
create function public.sec_read_presentation(p_report text) returns boolean
language sql security invoker set search_path='' as $$select sec_private.read_presentation(p_report)$$;

-- A presentation login cannot accidentally be linked back to a real employee.
create function sec_private.guard_presentation_account() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if exists(select 1 from sec_private.presentation_accounts p where p.user_id=new.user_id)
 and (new.person_id is not null or new.role<>'sec' or not new.is_test or new.primary_department is distinct from 'IM')
 then raise exception 'Presentation account must remain isolated' using errcode='42501';end if;
 return new;
end $$;
create trigger sec_presentation_account_guard before update on public.sec_accounts
for each row execute function sec_private.guard_presentation_account();
revoke all on function sec_private.guard_presentation_account() from public,anon,authenticated,service_role;
revoke all on function sec_private.own_presentation(),public.sec_own_presentation(),sec_private.read_presentation(text),public.sec_read_presentation(text) from public,anon,authenticated,service_role;
grant execute on function sec_private.own_presentation(),public.sec_own_presentation(),sec_private.read_presentation(text),public.sec_read_presentation(text) to authenticated;
notify pgrst,'reload schema';
