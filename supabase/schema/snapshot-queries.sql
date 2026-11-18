-- SCHEMASNAP.1 — the two read-only queries behind supabase/schema/snapshot.json.
-- Run each against the live project (Supabase MCP execute_sql, or the SQL
-- editor), save the single returned cell of each as a JSON file, then:
--   node scripts/schema-snapshot-build.mjs --columns <a.json> --rest <b.json> --through <highest applied migration number>

-- 1. Relations and columns (saved as --columns).
select json_object_agg(t, d order by t)::text as snapshot_columns from (
  select c.relname t, json_build_object(
    'kind', case c.relkind when 'r' then 'table' when 'p' then 'table' when 'v' then 'view' when 'm' then 'matview' end,
    'rls', c.relrowsecurity,
    'columns', (select json_agg(json_build_array(a.attname, format_type(a.atttypid, a.atttypmod), not a.attnotnull,
                  a.atthasdef or a.attidentity <> '' or a.attgenerated <> '') order by a.attnum)
                from pg_attribute a where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped)) d
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r','p','v','m')) s;

-- 2. Functions, enums, foreign keys, latest applied version (saved as --rest).
select json_build_object(
  'functions', (select json_agg(json_build_array(p.proname, pg_get_function_identity_arguments(p.oid), pg_get_function_result(p.oid), p.prosecdef)
                  order by p.proname, pg_get_function_identity_arguments(p.oid))
                from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                where n.nspname = 'public' and p.prokind = 'f'
                  and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')),
  'enums', (select json_object_agg(t, v order by t) from (
              select ty.typname t, json_agg(e.enumlabel order by e.enumsortorder) v
              from pg_type ty join pg_namespace n on n.oid = ty.typnamespace join pg_enum e on e.enumtypid = ty.oid
              where n.nspname = 'public' group by ty.typname) x),
  'foreign_keys', (select json_agg(json_build_array(c.conrelid::regclass::text,
                     (select json_agg(a.attname order by k.o) from unnest(c.conkey) with ordinality k(n,o) join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.n),
                     c.confrelid::regclass::text,
                     (select json_agg(a.attname order by k.o) from unnest(c.confkey) with ordinality k(n,o) join pg_attribute a on a.attrelid = c.confrelid and a.attnum = k.n))
                     order by c.conrelid::regclass::text, c.conname)
                   from pg_constraint c join pg_namespace n on n.oid = c.connamespace
                   where c.contype = 'f' and n.nspname = 'public'),
  'latest_applied', (select max(version) from supabase_migrations.schema_migrations))::text as snapshot_rest;
