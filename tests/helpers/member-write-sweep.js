// MEMBERWRITESWEEP.1 — shared PGlite harness for migrations 680-685.
//
// Boots PostgreSQL 17 (PGlite) with Supabase's DEFAULT PRIVILEGES (every
// table in public gets ALL for anon, authenticated and service_role — the
// source of the swept tables' arwdDxtm), the three private helpers the
// membership policies call (verbatim from prod, 30 Sep 2026) with prod
// EXECUTE, and reduced profiles / profile_locations / contacts. Each replay
// adds its own tables (reduced to the columns the policies and the service
// paths need: the migrations touch privileges and policies, never columns),
// the live policies verbatim, and a seed.
//
// Fictional ids only: the repo is public.

import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import path from 'node:path'

export const ALL_PRIVS = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN']
export const COLUMN_PRIVS = ['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']
export const CLIENT_ROLES = ['anon', 'authenticated', 'public']
export const denied = (t) => new RegExp(`permission denied for (table|relation) ${t}\\b`)
export const rlsRefused = (t) => new RegExp(`new row violates row-level security policy for table "${t}"`)

export const IDS = Object.freeze({
  LOC_A: 'a0000000-0000-0000-0000-00000000000a',
  LOC_B: 'b0000000-0000-0000-0000-00000000000b',
  STAFF_A: '10000000-0000-0000-0000-000000000001',   // plain staff at A
  OWNER_A: '10000000-0000-0000-0000-000000000002',   // owner at A
  STAFF_B: '10000000-0000-0000-0000-000000000003',   // plain staff at B only
  MASTER: '10000000-0000-0000-0000-000000000004',
  STAFF_MEMBER: '10000000-0000-0000-0000-000000000005', // staff at A who is also a member (own contact)
  MEMBER_UID: '20000000-0000-0000-0000-000000000001',   // a customer at A (no profile)
  MEMBER2_UID: '20000000-0000-0000-0000-000000000002',  // another customer at A
  C_MEMBER: '30000000-0000-0000-0000-000000000001',
  C_MEMBER2: '30000000-0000-0000-0000-000000000002',
  C_STAFF_MEMBER: '30000000-0000-0000-0000-000000000005',
  C_B: '30000000-0000-0000-0000-00000000000b',          // a contact at B
})

export const BASE_SCHEMA = `
  CREATE ROLE anon NOLOGIN;
  CREATE ROLE authenticated NOLOGIN;
  CREATE ROLE service_role NOLOGIN BYPASSRLS;
  CREATE ROLE other_grantor NOLOGIN;
  CREATE ROLE sneaky NOLOGIN;
  CREATE SCHEMA auth;
  CREATE SCHEMA private;
  GRANT USAGE ON SCHEMA auth, public, private TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;

  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
    SELECT nullif(current_setting('request.jwt.claims', true)::json->>'sub', '')::uuid
  $$;
  GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;

  CREATE TABLE public.locations (id uuid PRIMARY KEY);
  CREATE TABLE public.profiles (id uuid PRIMARY KEY, role text NOT NULL, active boolean DEFAULT true, deleted_at timestamptz);
  REVOKE ALL ON public.profiles FROM anon, authenticated;
  CREATE TABLE public.profile_locations (profile_id uuid, location_id uuid, role text NOT NULL, PRIMARY KEY (profile_id, location_id));
  REVOKE ALL ON public.profile_locations FROM anon, authenticated;
  CREATE TABLE public.contacts (id uuid PRIMARY KEY, location_id uuid, user_id uuid);
  REVOKE ALL ON public.contacts FROM anon, authenticated;

  -- private helpers, VERBATIM from prod (pg_get_functiondef, 30 Sep 2026).
  CREATE FUNCTION private.auth_is_in_location(loc_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO ''
  AS $function$
  SELECT loc_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = (SELECT auth.uid())
        AND p.active IS NOT FALSE
        AND p.deleted_at IS NULL
        AND (
          p.role = 'master'
          OR EXISTS (
            SELECT 1 FROM public.profile_locations
            WHERE profile_id = (SELECT auth.uid())
              AND location_id = loc_id
          )
        )
    )
  $function$;
  CREATE FUNCTION private.auth_is_master() RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO ''
  AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = (SELECT auth.uid())
      AND role = 'master'
      AND active IS NOT FALSE
      AND deleted_at IS NULL
  )
  $function$;
  CREATE FUNCTION private.auth_contact_id() RETURNS uuid
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
  AS $function$
    SELECT id FROM public.contacts WHERE user_id = auth.uid()
  $function$;
  -- prod EXECUTE (proacl, 30 Sep): in_location and contact_id postgres,
  -- authenticated, service_role only; auth_is_master keeps the default
  -- (proacl NULL = PUBLIC), so anon and authenticated both hold it.
  REVOKE ALL ON FUNCTION private.auth_is_in_location(uuid), private.auth_contact_id() FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION private.auth_is_in_location(uuid), private.auth_contact_id() TO authenticated, service_role;
`

export const BASE_SEED = `
  INSERT INTO public.locations VALUES ('${IDS.LOC_A}'), ('${IDS.LOC_B}');
  INSERT INTO public.profiles (id, role) VALUES
    ('${IDS.STAFF_A}', 'staff'), ('${IDS.OWNER_A}', 'owner'), ('${IDS.STAFF_B}', 'staff'),
    ('${IDS.MASTER}', 'master'), ('${IDS.STAFF_MEMBER}', 'staff');
  INSERT INTO public.profile_locations VALUES
    ('${IDS.STAFF_A}', '${IDS.LOC_A}', 'staff'), ('${IDS.OWNER_A}', '${IDS.LOC_A}', 'owner'),
    ('${IDS.STAFF_B}', '${IDS.LOC_B}', 'staff'), ('${IDS.STAFF_MEMBER}', '${IDS.LOC_A}', 'staff');
  INSERT INTO public.contacts VALUES
    ('${IDS.C_MEMBER}', '${IDS.LOC_A}', '${IDS.MEMBER_UID}'),
    ('${IDS.C_MEMBER2}', '${IDS.LOC_A}', '${IDS.MEMBER2_UID}'),
    ('${IDS.C_STAFF_MEMBER}', '${IDS.LOC_A}', '${IDS.STAFF_MEMBER}'),
    ('${IDS.C_B}', '${IDS.LOC_B}', NULL);
`

// Mig 677 (TABLEDEFAULTACL.1) is applied in prod (30 Sep 2026, 13:13 UTC):
// anon and PUBLIC hold nothing in public, and authenticated lost TRUNCATE,
// REFERENCES, TRIGGER and MAINTAIN (the swept tables read
// authenticated=arwd/postgres, no anon). Replays run in BOTH orders:
// boot({ after677: true }) replays 677 itself (the real file) on top of the
// seed, before the caller's `before` SQL and the sweep migration.
export const MIG_677 = readFileSync(path.resolve(import.meta.dirname,
  '../../supabase/migrations/677_public_tables_default_acl_closed.sql'), 'utf8')
// 677's own precondition reads the post-667 member RPC.
const MIG_677_PREREQS = `
  CREATE FUNCTION public.list_enabled_integrations() RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER AS 'SELECT 1';
  REVOKE ALL ON FUNCTION public.list_enabled_integrations() FROM PUBLIC, anon;
  GRANT EXECUTE ON FUNCTION public.list_enabled_integrations() TO authenticated;
`
/** The two prod states a sweep migration must apply to. */
export const PROD_STATES = [
  { label: 'before 677 (as planned)', after677: false },
  { label: 'after 677 (prod since 30 Sep)', after677: true },
]

// PGlite's multi-statement SQL runner (an in-process SQL call, no shell).
const run = (db, sql) => db['exec'](sql)

/** Boot: base schema, the replay's tables + policies, seed, (optionally) mig 677, then `before` and SQL files in order. */
export async function boot({ tables, policies, seed = '', after677 = false, before = '', migrate = [] }) {
  const db = new PGlite()
  await run(db, BASE_SCHEMA)
  await run(db, tables)
  await run(db, policies)
  await run(db, BASE_SEED)
  if (seed) await run(db, seed)
  if (after677) {
    await run(db, MIG_677_PREREQS)
    await run(db, MIG_677)
  }
  if (before) await run(db, before)
  for (const sql of migrate) await run(db, sql)
  return db
}

/** Run statements as a signed-in user inside a transaction that is always rolled back. Returns the last statement's rows. */
export async function asUser(db, uid, ...statements) {
  return runAs(db, { sub: uid, role: 'authenticated' }, 'authenticated', statements)
}
/** The same as a bare role (anon, service_role). */
export async function asRole(db, role, ...statements) {
  return runAs(db, { role }, role, statements)
}
async function runAs(db, claims, role, statements) {
  await run(db, 'BEGIN;')
  try {
    await db.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)])
    await run(db, `SET LOCAL ROLE ${role};`)
    let last
    for (const s of statements) last = await db.query(s)
    return last?.rows ?? []
  } finally {
    await run(db, 'ROLLBACK;')
  }
}

export async function policiesOf(db, tables) {
  const { rows } = await db.query(
    `SELECT tablename::text, policyname::text, permissive, cmd, roles::text AS roles, qual, with_check
       FROM pg_policies WHERE schemaname = 'public' AND tablename = ANY($1) ORDER BY 1, 2`, [tables])
  return rows
}

/** Every (role, privilege) a client role holds on a table, table level and column level. */
export async function clientPrivileges(db, table) {
  const held = []
  for (const r of CLIENT_ROLES) {
    for (const p of ALL_PRIVS) {
      const { rows } = await db.query(`SELECT has_table_privilege($1, $2, $3) AS h`, [r, `public.${table}`, p])
      if (rows[0].h) held.push(`${r}:${p}`)
    }
    for (const p of COLUMN_PRIVS) {
      const { rows } = await db.query(`SELECT has_any_column_privilege($1, $2, $3) AS h`, [r, `public.${table}`, p])
      if (rows[0].h) held.push(`${r}:col-${p}`)
    }
  }
  return held
}

export async function rlsOn(db, table) {
  const { rows } = await db.query(`SELECT relrowsecurity AS on FROM pg_class WHERE oid = $1::regclass`, [`public.${table}`])
  return rows[0].on
}

export async function serviceRoleDml(db, table) {
  for (const p of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
    const { rows } = await db.query(`SELECT has_table_privilege('service_role', $1, $2) AS h`, [`public.${table}`, p])
    if (!rows[0].h) return false
  }
  return true
}

/**
 * Run a migration; return the error message it raised (the self-check), or
 * null. A failed multi-statement run leaves its BEGIN open and aborted, so
 * it is rolled back here before the caller inspects the catalog.
 */
export async function abortMessage(db, sql) {
  try {
    await run(db, sql)
    return null
  } catch (e) {
    await run(db, 'ROLLBACK;')
    return String(e.message || e)
  }
}
