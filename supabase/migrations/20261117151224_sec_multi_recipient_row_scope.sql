-- Source imports can contain LH recipients; raw rows retain their target department scope.
alter policy sec_import_rows_read on public.sec_import_rows to authenticated
 using(exists(select 1 from public.sec_imports i where i.id=import_id)
  and exists(select 1 from public.sec_assignments a where a.id=assignment_id
   and a.department_id=any((select sec_private.department_scope())::text[])));
