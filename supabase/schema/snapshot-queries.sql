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

-- ROLETESTS.1: queries 3 to 5 feed supabase/schema/access.json through
--   node scripts/schema-access-build.mjs --policies <3> --grants <4> --functions <5> --through <n>

-- 3. Policies (saved as --policies).
select json_agg(json_build_array(c.relname, p.polname, p.polpermissive,
         case when p.polroles = '{0}' then array['public'] else (select array_agg(r.rolname order by r.rolname) from pg_roles r where r.oid = any(p.polroles)) end,
         p.polcmd, pg_get_expr(p.polqual, p.polrelid), pg_get_expr(p.polwithcheck, p.polrelid)) order by c.relname, p.polname)::text as policies
from pg_policy p join pg_class c on c.oid = p.polrelid join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public';

-- 4. Client grants on tables and columns (saved as --grants).
with r as (select oid, rolname from pg_roles where rolname in ('anon','authenticated')),
t as (select c.relname, a.privilege_type p, r.rolname g from pg_class c join pg_namespace n on n.oid = c.relnamespace
      cross join lateral aclexplode(c.relacl) a join r on r.oid = a.grantee
      where n.nspname = 'public' and c.relkind in ('r','v','m','p')),
col as (select c.relname, att.attname, a.privilege_type p, r.rolname g from pg_class c join pg_namespace n on n.oid = c.relnamespace
        join pg_attribute att on att.attrelid = c.oid and att.attnum > 0 and not att.attisdropped and att.attacl is not null
        cross join lateral aclexplode(att.attacl) a join r on r.oid = a.grantee where n.nspname = 'public')
select json_build_object('table_grants', (select json_agg(json_build_array(relname, g, p) order by relname, g, p) from t),
                         'column_grants', (select json_agg(json_build_array(relname, attname, g, p) order by relname, attname, g, p) from col))::text as grants;

-- 5. Functions and the two private lookup tables (saved as --functions).
select json_build_object(
  'functions', (select json_agg(json_build_array(n.nspname, p.proname, pg_get_function_identity_arguments(p.oid), pg_get_functiondef(p.oid),
      coalesce((select json_agg(distinct case when a.grantee = 0 then 'PUBLIC' else r.rolname end)
                from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a left join pg_roles r on r.oid = a.grantee
                where a.privilege_type = 'EXECUTE' and (a.grantee = 0 or r.rolname in ('anon','authenticated'))), '[]'::json))
      order by n.nspname, p.proname, pg_get_function_identity_arguments(p.oid))
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('private','public') and p.prokind = 'f' and pg_get_function_result(p.oid) not in ('trigger','event_trigger')
      and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')),
  'mobile_permission_defaults', (select json_agg(to_jsonb(d)) from private.mobile_permission_defaults d),
  'permission_key_bundles', (select json_agg(to_jsonb(b)) from private.permission_key_bundles b),
  'latest_applied', (select max(version) from supabase_migrations.schema_migrations))::text as fns;
