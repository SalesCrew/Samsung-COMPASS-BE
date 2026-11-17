begin;
do $test$
declare p uuid:=gen_random_uuid();a uuid:=gen_random_uuid();batch uuid:=gen_random_uuid();v numeric;n integer;
begin
 insert into public.sec_people(id,external_id,name) values(p,'qa-point-'||p::text,'Synthetic point evidence');
 insert into public.sec_assignments(id,person_id,department_id,setting,market) values(a,p,'IM','full','Synthetic history market');
 insert into sec_private.historical_point_evidence(person_id,department_id,month,points,source_month,source_sha256,source_file,source_page)
 values(p,'IM','2024-10-01',3,'2025-09-01',repeat('a',64),'synthetic.pdf',1);
 select points into v from sec_private.monthly_point_history('IM','2024-10-01','2024-10-01',p);
 if v is distinct from 3 then raise exception 'Missing evidence projection';end if;
 insert into sec_private.historical_point_evidence(person_id,department_id,month,points,source_month,source_sha256,source_file,source_page)
 values(p,'IM','2024-10-01',3,'2025-09-01',repeat('b',64),'synthetic-agrees.pdf',1);
 select count(*) into n from sec_private.monthly_point_history('IM','2024-10-01','2024-10-01',p);
 if n<>1 then raise exception 'Duplicate evidence counted twice';end if;
 insert into sec_private.historical_point_evidence(person_id,department_id,month,points,source_month,source_sha256,source_file,source_page)
 values(p,'IM','2024-10-01',2,'2025-09-01',repeat('c',64),'synthetic-conflict.pdf',1);
 select points into v from sec_private.monthly_point_history('IM','2024-10-01','2024-10-01',p);
 if v is not null then raise exception 'Conflicting evidence must stay unknown';end if;
 insert into public.sec_imports(id,department_id,month,phase,as_of,fingerprint,filename,sheet,mapping,status,row_count)
 values(batch,'IM','2024-10-01','MONTH_FINALIZATION','2024-10-31',encode(gen_random_bytes(32),'hex'),'synthetic-history-test.xlsx','Pivot Liste','[]','published',1);
 insert into public.sec_monthly_reports(person_id,assignment_id,department_id,month,revision,import_id,payload)
 values(p,a,'IM','2024-10-01',1,batch,'{"groupId":"IM","month":"2024-10","points":1,"premium":123}');
 select points into v from sec_private.monthly_point_history('IM','2024-10-01','2024-10-01',p);
 if v is distinct from 1 then raise exception 'Published report did not take precedence';end if;
 insert into public.sec_monthly_reports(person_id,assignment_id,department_id,month,revision,import_id,payload)
 values(p,a,'IM','2024-10-01',2,batch,'{"groupId":"IM","month":"2024-10","points":null,"premium":123}');
 select points into v from sec_private.monthly_point_history('IM','2024-10-01','2024-10-01',p);
 if v is not null then raise exception 'Unknown published correction was filled from older evidence';end if;
 select count(*) into n from sec_private.monthly_point_history('HE','2024-10-01','2024-10-01',p);
 if n<>0 then raise exception 'Division boundary lost';end if;
 if has_table_privilege('authenticated','sec_private.historical_point_evidence','SELECT')
 or has_table_privilege('authenticated','sec_private.historical_point_evidence','INSERT')
 or has_function_privilege('anon','public.sec_record_historical_points(jsonb)','EXECUTE')
 or has_function_privilege('service_role','public.sec_record_historical_points(jsonb)','EXECUTE')
 then raise exception 'Evidence privileges broadened';end if;
end $test$;
select 'point-only projection, conflicts, deduplication, immutable report precedence and privileges passed' as verification;
rollback;
