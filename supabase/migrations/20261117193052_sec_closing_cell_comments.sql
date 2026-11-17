-- Older published numeric snapshots stay immutable. Only verified source annotations
-- are stored here; future imports carry cell comments inside their own snapshot.
create table sec_private.closing_cell_comments(
 report_id uuid not null references public.sec_monthly_reports(id) on delete cascade,
 metric_key text not null check(length(metric_key) between 1 and 200),
 comments jsonb not null check(jsonb_typeof(comments)='array' and jsonb_array_length(comments) between 1 and 32),
 source_hash text not null check(source_hash ~ '^[a-f0-9]{64}$'),
 source_row integer not null check(source_row>0),
 created_at timestamptz not null default now(),
 primary key(report_id,metric_key),
 check(octet_length(comments::text)<=300000)
);
alter table sec_private.closing_cell_comments enable row level security;
alter table sec_private.closing_cell_comments force row level security;
revoke all on sec_private.closing_cell_comments from public,anon,authenticated,service_role;
create policy no_client_access on sec_private.closing_cell_comments for all to authenticated using(false) with check(false);

create function sec_private.closing_comments(p_assignment uuid default null) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare actor uuid:=sec_private.actor_id(); assignment public.sec_assignments;
begin
 if actor is null or not exists(select 1 from public.sec_accounts a where a.user_id=actor and not a.must_change_password)
 then raise exception 'Active account required' using errcode='42501'; end if;
 if p_assignment is not null then
  select * into assignment from public.sec_assignments where id=p_assignment;
  if assignment.id is null then raise exception 'SEC assignment not permitted' using errcode='42501'; end if;
  if not(assignment.department_id=any(sec_private.department_scope())) then
   assignment:=sec_private.dashboard_assignment(p_assignment);
  end if;
 end if;
 return(select coalesce(jsonb_agg(jsonb_build_object('report_id',c.report_id,'metric_key',c.metric_key,'comments',c.comments) order by c.report_id,c.metric_key),'[]'::jsonb)
  from sec_private.closing_cell_comments c join public.sec_monthly_reports r on r.id=c.report_id
  where case when p_assignment is not null then r.assignment_id=p_assignment else r.person_id=sec_private.actor_person() end);
end $$;
create function public.sec_closing_comments(p_assignment uuid default null) returns jsonb
language sql stable security invoker set search_path='' as $$ select sec_private.closing_comments(p_assignment) $$;
revoke all on function sec_private.closing_comments(uuid),public.sec_closing_comments(uuid) from public,anon,authenticated,service_role;
grant execute on function sec_private.closing_comments(uuid),public.sec_closing_comments(uuid) to authenticated;
