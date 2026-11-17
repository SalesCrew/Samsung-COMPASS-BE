begin;
do $test$
declare u uuid:=gen_random_uuid();s uuid:=gen_random_uuid();p uuid:=gen_random_uuid();other uuid:=gen_random_uuid();v jsonb;
begin
 insert into auth.users(id,email) values(u,'qa-point-export-'||u::text||'@example.invalid');
 insert into auth.sessions(id,user_id) values(s,u);
 insert into public.sec_people(id,external_id,name) values(p,'qa-point-export-'||p::text,'Synthetic own'),(other,'qa-point-export-'||other::text,'Synthetic peer');
 insert into public.sec_assignments(person_id,department_id,market) values(p,'IM','Synthetic own'),(other,'IM','Synthetic peer');
 insert into public.sec_accounts(user_id,email,display_name,role,department_ids,primary_department,setting,person_id,active,is_test,must_change_password)
 values(u,'qa-point-export-'||u::text||'@example.invalid','Synthetic own','sec',array['IM'],'IM','full',p,true,true,false);
 insert into sec_private.historical_point_evidence(person_id,department_id,month,points,source_month,source_sha256,source_file,source_page)
 values(p,'IM','2024-10-01',3,'2025-09-01',repeat('a',64),'synthetic-own.pdf',1),(other,'IM','2024-10-01',1,'2025-09-01',repeat('b',64),'synthetic-peer.pdf',1);
 perform set_config('request.jwt.claims',jsonb_build_object('sub',u,'role','authenticated','session_id',s,'aal','aal1')::text,true);
 v:=public.sec_own_point_evidence();
 if jsonb_array_length(v)<>1 or v->0->>'sourceFile'<>'synthetic-own.pdf' or v->0->>'points'<>'3'
 then raise exception 'Own point export leaked/missed evidence';end if;
 begin
  perform public.sec_record_historical_points('[]'::jsonb);
  raise exception 'SEC wrote evidence';
 exception when insufficient_privilege then null;end;
 update public.sec_accounts set must_change_password=true where user_id=u;
 begin perform public.sec_own_point_evidence();raise exception 'Initial password read evidence';
 exception when insufficient_privilege then null;end;
 update public.sec_accounts set must_change_password=false,active=false where user_id=u;
 begin perform public.sec_own_point_evidence();raise exception 'Disabled actor read evidence';
 exception when insufficient_privilege then null;end;
 update public.sec_accounts set active=true where user_id=u;
 delete from auth.sessions where id=s;
 begin perform public.sec_own_point_evidence();raise exception 'Revoked session read evidence';
 exception when insufficient_privilege then null;end;
 if has_function_privilege('anon','public.sec_own_point_evidence()','EXECUTE')
 or has_function_privilege('service_role','public.sec_own_point_evidence()','EXECUTE')
 then raise exception 'Export privileges broadened';end if;
end $test$;
select 'Own-only export, peer isolation, write denial, initial password, disabled/revoked actor and privilege checks passed' as verification;
rollback;
