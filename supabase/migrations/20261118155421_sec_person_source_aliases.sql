-- Optional source usernames used only to find an existing person in admin pickers.
-- Existing sec_people RLS continues to protect every row and no direct write is granted.
alter table public.sec_people add column source_aliases text[] not null default '{}'
 check(cardinality(source_aliases)<=20);
create function sec_private.set_person_aliases(p_person uuid,p_aliases text[],p_source_hash text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare aliases text[];
begin
 if sec_private.actor_id() is null or not sec_private.is_app_admin()
 then raise exception 'Verified app administrator required' using errcode='42501'; end if;
 if p_person is null or p_aliases is null or cardinality(p_aliases)>20
 or p_source_hash is null or p_source_hash !~ '^[a-f0-9]{64}$'
 or exists(select 1 from unnest(p_aliases) a where a is null or length(btrim(a)) not between 1 and 100 or a ~ '[[:cntrl:]]')
 then raise exception 'Invalid source aliases or provenance'; end if;
 if not exists(select 1 from public.sec_accounts a where a.person_id=p_person and a.role='sec' and a.active)
 then raise exception 'Existing active SEC identity required'; end if;
 select coalesce(array_agg(alias order by alias),'{}'::text[]) into aliases
 from(select distinct lower(btrim(value)) as alias from unnest(p_aliases) value) normalized;
 update public.sec_people set source_aliases=aliases where id=p_person;
 if not found then raise exception 'Existing person required'; end if;
 perform sec_private.audit(null,'identity.aliases_updated','person',p_person,
  jsonb_build_object('alias_count',cardinality(aliases),'source_sha256',p_source_hash));
 return jsonb_build_object('person_id',p_person,'alias_count',cardinality(aliases));
end $$;
create function public.sec_set_person_aliases(p_person uuid,p_aliases text[],p_source_hash text)
returns jsonb language sql security invoker set search_path='' as $$
 select sec_private.set_person_aliases(p_person,p_aliases,p_source_hash)
$$;
revoke all on function sec_private.set_person_aliases(uuid,text[],text),public.sec_set_person_aliases(uuid,text[],text) from public,anon,authenticated,service_role;
grant execute on function sec_private.set_person_aliases(uuid,text[],text),public.sec_set_person_aliases(uuid,text[],text) to authenticated;
notify pgrst,'reload schema';
