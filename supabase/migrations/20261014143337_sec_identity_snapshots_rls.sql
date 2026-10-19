-- SEC identity, scoped administration, immutable published snapshots and privacy records.
-- Business reads use end-user JWTs. No anonymous data access or user-editable metadata authorization.
create schema if not exists sec_private;
revoke all on schema sec_private from public, anon;
grant usage on schema sec_private to authenticated, service_role;

create table public.sec_departments (
 id text primary key check (id in ('HE','DA','IM','LH','ST')),
 label text not null
);
insert into public.sec_departments values
 ('HE','Home Entertainment'),('DA','Domestic Appliances'),('IM','Mobile'),
 ('LH','Lighthouse / Brand Island'),('ST','SmartThings');

create table public.sec_people (
 id uuid primary key default gen_random_uuid(),
 external_id text not null unique check (length(btrim(external_id)) between 1 and 120),
 name text not null default '',
 created_at timestamptz not null default now()
);
create table public.sec_accounts (
 user_id uuid primary key references auth.users(id) on delete cascade,
 email text not null,
 display_name text not null default '',
 role text not null check (role in ('app_admin','department_admin','sec')),
 department_ids text[] not null default '{}'
   check (department_ids <@ array['HE','DA','IM','LH','ST']::text[]),
 person_id uuid references public.sec_people(id),
 primary_department text references public.sec_departments(id),
 setting text not null default 'full' check (setting in ('full','laundry-ref','vc')),
 active boolean not null default true,
 must_change_password boolean not null default true,
 notice_version text,
 notice_acknowledged_at timestamptz,
 is_test boolean not null default false,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 check (role = 'app_admin' or cardinality(department_ids) > 0),
 check (role <> 'sec' or (cardinality(department_ids) = 1 and primary_department = any(department_ids)))
);
create unique index sec_accounts_email_idx on public.sec_accounts(lower(email));
create index sec_accounts_person_idx on public.sec_accounts(person_id);
create index sec_accounts_departments_idx on public.sec_accounts using gin(department_ids);

create table public.sec_security_settings (
 singleton boolean primary key default true check(singleton),
 require_admin_mfa boolean not null default false,
 notice_version text not null default 'sec-2026-10-14'
);
insert into public.sec_security_settings(singleton) values(true);

create table public.sec_assignments (
 id uuid primary key default gen_random_uuid(),
 person_id uuid not null references public.sec_people(id),
 department_id text not null references public.sec_departments(id),
 setting text not null default 'full' check (setting in ('full','laundry-ref','vc')),
 market text not null check (length(btrim(market)) between 1 and 300),
 source_shop_id text,
 created_at timestamptz not null default now(),
 unique(person_id, department_id, setting, market)
);
create index sec_assignments_department_idx on public.sec_assignments(department_id,person_id);

create table public.sec_config_versions (
 id uuid primary key default gen_random_uuid(),
 department_id text not null references public.sec_departments(id),
 setting text not null default 'full' check (setting in ('full','laundry-ref','vc')),
 effective_month date not null check (extract(day from effective_month)=1),
 version integer not null check(version>0),
 definition jsonb not null check(jsonb_typeof(definition)='object'),
 note text not null default '',
 created_by uuid references auth.users(id) on delete set null,
 created_at timestamptz not null default now(),
 unique(department_id,setting,effective_month,version)
);
create index sec_configs_created_by_idx on public.sec_config_versions(created_by);

create table public.sec_imports (
 id uuid primary key default gen_random_uuid(),
 department_id text not null references public.sec_departments(id),
 month date not null check(extract(day from month)=1),
 phase text not null check(phase in ('TARGET_INITIALIZATION','WEEKLY_PROGRESS','MONTH_FINALIZATION')),
 as_of date not null,
 fingerprint text not null check(fingerprint ~ '^[a-f0-9]{64}$'),
 filename text not null,
 sheet text not null,
 mapping jsonb not null,
 config_id uuid references public.sec_config_versions(id),
 status text not null default 'draft' check(status in ('draft','published','rejected')),
 row_count integer not null default 0 check(row_count >= 0),
 created_by uuid references auth.users(id) on delete set null,
 published_by uuid references auth.users(id) on delete set null,
 created_at timestamptz not null default now(),
 published_at timestamptz,
 unique(department_id,month,phase,fingerprint),
 check(date_trunc('month',as_of)::date=month)
);
create index sec_imports_scope_idx on public.sec_imports(department_id,month,created_at desc);
create index sec_imports_config_idx on public.sec_imports(config_id);
create index sec_imports_created_by_idx on public.sec_imports(created_by);
create index sec_imports_published_by_idx on public.sec_imports(published_by);

create table public.sec_import_rows (
 id uuid primary key default gen_random_uuid(),
 import_id uuid not null references public.sec_imports(id) on delete cascade,
 person_id uuid not null references public.sec_people(id),
 assignment_id uuid not null references public.sec_assignments(id),
 source_row integer not null check(source_row>0),
 fields jsonb not null check(jsonb_typeof(fields)='object'),
 normalized jsonb not null check(jsonb_typeof(normalized)='object'),
 unique(import_id,person_id,assignment_id)
);
create index sec_import_rows_person_idx on public.sec_import_rows(person_id);
create index sec_import_rows_assignment_idx on public.sec_import_rows(assignment_id);

create table public.sec_monthly_reports (
 id uuid primary key default gen_random_uuid(),
 person_id uuid not null references public.sec_people(id),
 assignment_id uuid not null references public.sec_assignments(id),
 department_id text not null references public.sec_departments(id),
 month date not null check(extract(day from month)=1),
 revision integer not null check(revision>0),
 import_id uuid not null references public.sec_imports(id),
 configuration_id uuid references public.sec_config_versions(id),
 payload jsonb not null check(jsonb_typeof(payload)='object'),
 published_at timestamptz not null default now(),
 unique(person_id,assignment_id,month,revision),
 check(payload->>'groupId'=department_id and payload->>'month'=to_char(month,'YYYY-MM'))
);
create index sec_monthly_owner_idx on public.sec_monthly_reports(person_id,month desc,revision desc);
create index sec_monthly_scope_idx on public.sec_monthly_reports(department_id,month);
create index sec_monthly_assignment_idx on public.sec_monthly_reports(assignment_id);
create index sec_monthly_import_idx on public.sec_monthly_reports(import_id);
create index sec_monthly_config_idx on public.sec_monthly_reports(configuration_id);

create table public.sec_weekly_snapshots (
 id uuid primary key default gen_random_uuid(),
 person_id uuid not null references public.sec_people(id),
 assignment_id uuid not null references public.sec_assignments(id),
 department_id text not null references public.sec_departments(id),
 month date not null check(extract(day from month)=1),
 as_of date not null,
 revision integer not null check(revision>0),
 import_id uuid not null references public.sec_imports(id),
 payload jsonb not null check(jsonb_typeof(payload->'metrics')='array'),
 published_at timestamptz not null default now(),
 unique(person_id,assignment_id,month,as_of,revision),
 check(date_trunc('month',as_of)::date=month),
 check(payload->>'groupId'=department_id and payload->>'month'=to_char(month,'YYYY-MM'))
);
create index sec_weekly_owner_idx on public.sec_weekly_snapshots(person_id,month,as_of,revision desc);
create index sec_weekly_scope_idx on public.sec_weekly_snapshots(department_id,month);
create index sec_weekly_assignment_idx on public.sec_weekly_snapshots(assignment_id);
create index sec_weekly_import_idx on public.sec_weekly_snapshots(import_id);

create table public.sec_read_receipts (
 user_id uuid not null references auth.users(id) on delete cascade,
 report_id uuid not null references public.sec_monthly_reports(id) on delete cascade,
 read_at timestamptz not null default now(),
 primary key(user_id,report_id)
);
create index sec_read_report_idx on public.sec_read_receipts(report_id);

create table public.sec_audit_events (
 id uuid primary key default gen_random_uuid(),
 actor_id uuid references auth.users(id) on delete set null,
 department_id text references public.sec_departments(id),
 action text not null,
 resource_type text not null,
 resource_id uuid,
 details jsonb not null default '{}',
 created_at timestamptz not null default now()
);
create index sec_audit_scope_idx on public.sec_audit_events(department_id,created_at desc);
create index sec_audit_actor_idx on public.sec_audit_events(actor_id);

create table public.sec_privacy_requests (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references auth.users(id),
 person_id uuid references public.sec_people(id),
 department_id text references public.sec_departments(id),
 kind text not null check(kind in ('access','correction','erasure','restriction','objection','portability')),
 message text not null default '' check(length(message)<=4000),
 status text not null default 'open' check(status in ('open','in_review','fulfilled','declined')),
 identity_checked_at timestamptz,
 response text not null default '',
 handled_by uuid references auth.users(id) on delete set null,
 created_at timestamptz not null default now(),
 due_at timestamptz not null default (now()+interval '1 month'),
 completed_at timestamptz
);
create index sec_privacy_owner_idx on public.sec_privacy_requests(user_id);
create index sec_privacy_person_idx on public.sec_privacy_requests(person_id);
create index sec_privacy_handler_idx on public.sec_privacy_requests(handled_by);
create index sec_privacy_scope_idx on public.sec_privacy_requests(department_id,status,due_at);

create table public.sec_retention_policies (
 category text primary key,
 months integer not null check(months>0),
 approved boolean not null default false,
 approved_by uuid references auth.users(id) on delete set null,
 approved_at timestamptz
);
insert into public.sec_retention_policies(category,months) values
 ('operational_reporting',36),('payout_evidence',84),('security_audit',24),('technical_details',3);
create index sec_retention_approver_idx on public.sec_retention_policies(approved_by);

create table public.sec_legal_holds (
 id uuid primary key default gen_random_uuid(),
 person_id uuid references public.sec_people(id),
 department_id text references public.sec_departments(id),
 reason text not null check(length(reason) between 1 and 1000),
 created_by uuid references auth.users(id) on delete set null,
 created_at timestamptz not null default now(),
 released_at timestamptz,
 check(person_id is not null or department_id is not null)
);
create index sec_holds_person_idx on public.sec_legal_holds(person_id);
create index sec_holds_creator_idx on public.sec_legal_holds(created_by);

-- The private helper intentionally bypasses table RLS for a live authorization lookup.
-- It binds to auth.uid and an existing session, never user_metadata or a supplied user ID.
create function sec_private.actor_id() returns uuid
 language sql stable security definer set search_path='' as $$
 select a.user_id from public.sec_accounts a
 where a.user_id=(select auth.uid()) and a.active
 and exists(select 1 from auth.sessions s
   where s.id=nullif((select auth.jwt())->>'session_id','')::uuid and s.user_id=a.user_id)
 and (a.role='sec' or not (select require_admin_mfa from public.sec_security_settings where singleton)
   or (select auth.jwt())->>'aal'='aal2')
$$;
create function sec_private.is_app_admin() returns boolean
 language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.sec_accounts where user_id=sec_private.actor_id() and role='app_admin')
$$;
create function sec_private.department_scope() returns text[]
 language sql stable security definer set search_path='' as $$
 select coalesce((select case when role='app_admin' then array['HE','DA','IM','LH','ST']::text[]
   when role='department_admin' then department_ids else '{}'::text[] end
   from public.sec_accounts where user_id=sec_private.actor_id()),'{}'::text[])
$$;
create function sec_private.actor_person() returns uuid
 language sql stable security definer set search_path='' as $$
 select person_id from public.sec_accounts where user_id=sec_private.actor_id()
$$;
create function sec_private.can_person(p_person uuid) returns boolean
 language sql stable security definer set search_path='' as $$
 select sec_private.actor_id() is not null and
 (p_person=sec_private.actor_person() or sec_private.is_app_admin()
 or exists(select 1 from public.sec_assignments where person_id=p_person
   and department_id=any(sec_private.department_scope())))
$$;

do $$
declare t record;
begin
 for t in select tablename from pg_tables where schemaname='public' and tablename like 'sec_%'
 loop
  execute format('alter table public.%I enable row level security',t.tablename);
  execute format('revoke all on table public.%I from public,anon,authenticated,service_role',t.tablename);
  execute format('grant select on table public.%I to authenticated,service_role',t.tablename);
 end loop;
end $$;
grant insert,update on public.sec_accounts to service_role;
grant select,insert,update on public.sec_read_receipts to authenticated;
grant insert on public.sec_privacy_requests to authenticated;

create policy sec_departments_read on public.sec_departments for select to authenticated
 using((select sec_private.actor_id()) is not null);
create policy sec_account_read on public.sec_accounts for select to authenticated
 using(user_id=(select sec_private.actor_id()) or (select sec_private.is_app_admin())
 or (role='sec' and department_ids && (select sec_private.department_scope())));
create policy sec_people_read on public.sec_people for select to authenticated
 using(sec_private.can_person(id));
create policy sec_assignments_read on public.sec_assignments for select to authenticated
 using(person_id=(select sec_private.actor_person()) or department_id=any((select sec_private.department_scope())::text[]));
create policy sec_config_read on public.sec_config_versions for select to authenticated
 using(department_id=any((select sec_private.department_scope())::text[]));
create policy sec_import_read on public.sec_imports for select to authenticated
 using(department_id=any((select sec_private.department_scope())::text[]));
create policy sec_import_rows_read on public.sec_import_rows for select to authenticated
 using(exists(select 1 from public.sec_imports i where i.id=import_id));
create policy sec_monthly_read on public.sec_monthly_reports for select to authenticated
 using(person_id=(select sec_private.actor_person()) or department_id=any((select sec_private.department_scope())::text[]));
create policy sec_weekly_read on public.sec_weekly_snapshots for select to authenticated
 using(person_id=(select sec_private.actor_person()) or department_id=any((select sec_private.department_scope())::text[]));
create policy sec_receipts_read on public.sec_read_receipts for select to authenticated
 using(user_id=(select sec_private.actor_id()));
create policy sec_receipts_insert on public.sec_read_receipts for insert to authenticated
 with check(user_id=(select sec_private.actor_id()) and exists(select 1 from public.sec_monthly_reports r where r.id=report_id));
create policy sec_receipts_update on public.sec_read_receipts for update to authenticated
 using(user_id=(select sec_private.actor_id()))
 with check(user_id=(select sec_private.actor_id()) and exists(select 1 from public.sec_monthly_reports r where r.id=report_id));
create policy sec_audit_read on public.sec_audit_events for select to authenticated
 using((department_id is null and (select sec_private.is_app_admin()))
 or department_id=any((select sec_private.department_scope())::text[]));
create policy sec_privacy_read on public.sec_privacy_requests for select to authenticated
 using(user_id=(select sec_private.actor_id()) or (select sec_private.is_app_admin())
 or department_id=any((select sec_private.department_scope())::text[]));
create policy sec_privacy_insert on public.sec_privacy_requests for insert to authenticated
 with check(user_id=(select sec_private.actor_id()) and person_id is not distinct from (select sec_private.actor_person())
 and department_id is not distinct from (select primary_department from public.sec_accounts where user_id=(select sec_private.actor_id()))
 and status='open' and response='' and handled_by is null and identity_checked_at is null and completed_at is null);
create policy sec_security_settings_read on public.sec_security_settings for select to authenticated
 using((select sec_private.is_app_admin()));
create policy sec_retention_read on public.sec_retention_policies for select to authenticated
 using((select sec_private.is_app_admin()));
create policy sec_holds_read on public.sec_legal_holds for select to authenticated
 using((select sec_private.is_app_admin()) or department_id=any((select sec_private.department_scope())::text[]));

-- Auth account administration is the only initial service-key table write.
-- Business writes will be narrow, identity-checked transaction RPCs.
revoke all on all functions in schema sec_private from public, anon, authenticated, service_role;
grant execute on function sec_private.actor_id(),sec_private.is_app_admin(),sec_private.department_scope(),sec_private.actor_person(),sec_private.can_person(uuid) to authenticated;
alter default privileges in schema sec_private revoke execute on functions from public;
alter default privileges in schema public revoke execute on functions from public;

