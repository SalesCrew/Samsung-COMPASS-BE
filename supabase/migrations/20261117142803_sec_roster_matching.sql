-- User-authorized, minimal reference data; no supervisor, salary or unrestricted HR fields.
create table public.sec_roster_entries (
 id uuid primary key default gen_random_uuid(),
 email text not null check(length(email) between 3 and 320),
 department_id text not null references public.sec_departments(id),
 first_name text not null check(length(btrim(first_name)) between 1 and 200),
 last_name text not null check(length(btrim(last_name)) between 1 and 200),
 market text not null check(length(btrim(market)) between 1 and 500),
 person_id uuid references public.sec_people(id) on delete set null,
 source_month text not null check(source_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
 source_hash text not null check(source_hash ~ '^[a-f0-9]{64}$'),
 source_row integer not null check(source_row between 2 and 100000),
 imported_by uuid references auth.users(id) on delete set null,
 imported_at timestamptz not null default now(),
 unique(source_hash,source_row)
);
create index sec_roster_department_month_idx on public.sec_roster_entries(department_id,source_month,imported_at);
create index sec_roster_person_idx on public.sec_roster_entries(person_id);
create index sec_roster_importer_idx on public.sec_roster_entries(imported_by);
alter table public.sec_roster_entries enable row level security;
alter table public.sec_roster_entries force row level security;
revoke all on public.sec_roster_entries from public,anon,authenticated,service_role;
grant select on public.sec_roster_entries to authenticated;
create policy sec_roster_admin_read on public.sec_roster_entries for select to authenticated
 using(department_id=any((select sec_private.department_scope())::text[]));

create function sec_private.import_roster(p_rows jsonb,p_source_hash text,p_source_month text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare item jsonb; linked uuid; links integer; total integer:=0; linked_total integer:=0; row_no integer;
begin
 if sec_private.actor_id() is null or not sec_private.is_app_admin()
 then raise exception 'Verified app administrator required' using errcode='42501'; end if;
 if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows) not between 1 and 5000
 or p_source_hash is null or p_source_hash !~ '^[a-f0-9]{64}$'
 or p_source_month is null or p_source_month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
 then raise exception 'Invalid roster structure or source'; end if;
 perform pg_advisory_xact_lock(hashtext('sec_roster_import'));
 if exists(select 1 from jsonb_array_elements(p_rows) r group by r->>'source_row' having count(*)>1)
 then raise exception 'Duplicate roster source row'; end if;
 if exists(select 1 from public.sec_roster_entries where source_hash=p_source_hash)
 then
  if exists(select 1 from public.sec_roster_entries where source_hash=p_source_hash and source_month<>p_source_month)
  then raise exception 'Source month conflicts with existing source'; end if;
  return jsonb_build_object('count',(select count(*) from public.sec_roster_entries where source_hash=p_source_hash),
   'linked',(select count(*) from public.sec_roster_entries where source_hash=p_source_hash and person_id is not null),'unchanged',true);
 end if;
 for item in select value from jsonb_array_elements(p_rows) loop
  row_no:=(item->>'source_row')::integer;
  if item->>'department_id' is null or item->>'department_id' not in ('HE','DA','IM','LH','ST')
  or coalesce(item->>'email','') !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
  or length(coalesce(btrim(item->>'first_name'),'')) not between 1 and 200
  or length(coalesce(btrim(item->>'last_name'),'')) not between 1 and 200
  or length(coalesce(btrim(item->>'market'),'')) not between 1 and 500
  then raise exception 'Invalid required roster field at source row %',row_no; end if;
  select count(distinct a.person_id),(array_agg(distinct a.person_id))[1] into links,linked
  from public.sec_accounts a where lower(a.email)=lower(btrim(item->>'email'))
   and a.active and not a.is_test and a.role='sec' and a.person_id is not null;
  if links<>1 then linked:=null; end if;
  insert into public.sec_roster_entries(email,department_id,first_name,last_name,market,person_id,source_month,source_hash,source_row,imported_by)
  values(lower(btrim(item->>'email')),item->>'department_id',btrim(item->>'first_name'),btrim(item->>'last_name'),
   btrim(item->>'market'),linked,p_source_month,p_source_hash,row_no,sec_private.actor_id());
  total:=total+1;if linked is not null then linked_total:=linked_total+1;end if;
 end loop;
 perform sec_private.audit(null,'roster.imported','roster',null,jsonb_build_object('count',total,'linked',linked_total,'source_hash',p_source_hash,'source_month',p_source_month));
 return jsonb_build_object('count',total,'linked',linked_total,'unchanged',false);
end $$;
create function public.sec_import_roster(p_rows jsonb,p_source_hash text,p_source_month text)
returns jsonb language sql security invoker set search_path='' as $$
 select sec_private.import_roster(p_rows,p_source_hash,p_source_month)
$$;
revoke all on function sec_private.import_roster(jsonb,text,text),public.sec_import_roster(jsonb,text,text) from public,anon,authenticated,service_role;
grant execute on function sec_private.import_roster(jsonb,text,text),public.sec_import_roster(jsonb,text,text) to authenticated;
notify pgrst,'reload schema';
