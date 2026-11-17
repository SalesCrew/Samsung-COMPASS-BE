-- Real permissions and durable read markers; fixture accounts and changes roll back.
begin;
create temporary table presentation_actor(n integer,user_id uuid,session_id uuid);
insert into presentation_actor select n,gen_random_uuid(),gen_random_uuid() from generate_series(1,3) n;
insert into auth.users(id,email) select user_id,'presentation-'||user_id||'@example.invalid' from presentation_actor;
insert into auth.sessions(id,user_id) select session_id,user_id from presentation_actor;
insert into public.sec_accounts(user_id,email,display_name,role,department_ids,primary_department,person_id,is_test,must_change_password)
 select user_id,'presentation-'||user_id||'@example.invalid','Synthetic presentation verifier','sec',array[case when n=3 then 'HE' else 'IM' end],case when n=3 then 'HE' else 'IM' end,null,n in (1,3),false from presentation_actor;
insert into sec_private.presentation_accounts(user_id,department_id) select user_id,case when n=3 then 'HE' else 'IM' end from presentation_actor where n in (1,3);
grant select on presentation_actor to authenticated;
select set_config('request.jwt.claims',jsonb_build_object('sub',user_id,'role','authenticated','session_id',session_id,'aal','aal1')::text,true) from presentation_actor where n=1;
set local role authenticated;
do $$declare d jsonb;id text;m date;begin
 d:=public.sec_own_presentation();if d is null or d->>'market'<>'Media Markt Mustermann' then raise exception 'Own presentation unavailable';end if;
 if exists(select 1 from public.sec_monthly_reports) or exists(select 1 from public.sec_weekly_snapshots) or exists(select 1 from public.sec_assignments) then raise exception 'Presentation actor accessed business data';end if;
 m:=(date_trunc('month',timezone('Europe/Vienna',now()))-case when extract(day from timezone('Europe/Vienna',now()))>=15 then interval '1 month' else interval '2 months' end)::date;
 id:='presentation-'||(d->>'assignmentId')||'-'||to_char(m,'YYYY-MM');
 if not public.sec_read_presentation(id) or not public.sec_read_presentation(id) then raise exception 'Own read acknowledgement failed';end if;
 if jsonb_array_length(public.sec_own_presentation()->'readIds')<>1 then raise exception 'Read marker was not persisted once';end if;
 begin perform public.sec_read_presentation(gen_random_uuid()::text);raise exception 'Foreign read accepted';exception when insufficient_privilege then null;end;
 begin perform public.sec_read_presentation('presentation-'||(d->>'assignmentId')||'-1900-01');raise exception 'Invalid history accepted';exception when insufficient_privilege then null;end;
 begin perform * from sec_private.presentation_accounts;raise exception 'Private table exposed';exception when insufficient_privilege then null;end;
end $$;
reset role;
do $$begin
 begin update public.sec_accounts set primary_department='HE',department_ids=array['HE'] where user_id=(select user_id from presentation_actor where n=1);raise exception 'Presentation account repurposed';exception when insufficient_privilege then null;end;
end $$;
select set_config('request.jwt.claims',jsonb_build_object('sub',user_id,'role','authenticated','session_id',session_id,'aal','aal1')::text,true) from presentation_actor where n=2;
set local role authenticated;
do $$begin if public.sec_own_presentation() is not null or public.sec_read_presentation('not-a-report') then raise exception 'Ordinary actor saw a presentation';end if;end $$;
reset role;
update public.sec_accounts set active=false where user_id=(select user_id from presentation_actor where n=1);
select set_config('request.jwt.claims',jsonb_build_object('sub',user_id,'role','authenticated','session_id',session_id,'aal','aal1')::text,true) from presentation_actor where n=1;
set local role authenticated;
do $$begin begin perform public.sec_own_presentation();raise exception 'Disabled actor accepted';exception when insufficient_privilege then null;end;end $$;
reset role;
-- A distinct HE presentation has the same owner-only protections.
select set_config('request.jwt.claims',jsonb_build_object('sub',user_id,'role','authenticated','session_id',session_id,'aal','aal1')::text,true) from presentation_actor where n=3;
set local role authenticated;
do $$declare d jsonb;id text;m date;begin
 d:=public.sec_own_presentation();if d is null then raise exception 'HE presentation unavailable';end if;
 if exists(select 1 from public.sec_monthly_reports) or exists(select 1 from public.sec_weekly_snapshots) or exists(select 1 from public.sec_assignments) then raise exception 'HE presentation accessed business data';end if;
 m:=(date_trunc('month',timezone('Europe/Vienna',now()))-case when extract(day from timezone('Europe/Vienna',now()))>=15 then interval '1 month' else interval '2 months' end)::date;
 id:='presentation-'||(d->>'assignmentId')||'-'||to_char(m,'YYYY-MM');
 if not public.sec_read_presentation(id) or not public.sec_read_presentation(id) then raise exception 'HE own marker failed';end if;
 if jsonb_array_length(public.sec_own_presentation()->'readIds')<>1 then raise exception 'HE marker not durable/idempotent';end if;
 begin perform * from sec_private.presentation_accounts;raise exception 'HE private table exposed';exception when insufficient_privilege then null;end;
 begin perform public.sec_read_presentation('presentation-'||gen_random_uuid()||'-'||to_char(m,'YYYY-MM'));raise exception 'HE foreign marker accepted';exception when insufficient_privilege then null;end;
end $$;
reset role;
do $$begin
 begin update public.sec_accounts set primary_department='IM',department_ids=array['IM'] where user_id=(select user_id from presentation_actor where n=3);raise exception 'HE presentation repurposed';exception when insufficient_privilege then null;end;
end $$;
set local role anon;
do $$begin begin perform public.sec_own_presentation();raise exception 'Anonymous presentation access';exception when insufficient_privilege then null;end;end $$;
reset role;
rollback;
select 'presentation isolation and read markers passed; fixtures rolled back' as verification;
