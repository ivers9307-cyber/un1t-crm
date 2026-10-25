// W0.5b — behavioural RLS test for migration 714.
//
// W0.5 (mig 713, #1960) gave policies an organization_id and narrowed the
// authenticated SELECT policies to the caller's organisations. The six WRITE
// policies (mig 320, active-staff gate from mig 626) were left alone, so an
// active OWNER could insert, update or delete policies / policy_versions in
// ANY organisation through the browser client. Mig 714 scopes them.
//
// No local Supabase stack exists, so this boots PGlite with the minimum the
// policies touch: the tables, the mig-626 helper bodies (active + not
// tombstoned, org membership via a location OR a profile_organizations
// grant), the six write policies exactly as mig 626 left them and the two
// read policies from mig 713. It proves the leak first (guards against a
// vacuous pass), applies the REAL 714 file, then asserts per command who may
// touch which organisation's rows. Fictional ids only: the repo is public.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const MIG_714 = readFileSync(
  path.resolve(import.meta.dirname, '../supabase/migrations/714_policies_write_rls_org.sql'),
  'utf8',
)

const ORG_A = 'a0000000-0000-4000-8000-00000000000a'
const ORG_B = 'b0000000-0000-4000-8000-00000000000b'
const LOC_A = 'a0000000-0000-4000-8000-0000000000a1'
const LOC_B = 'b0000000-0000-4000-8000-0000000000b1'

const OWNER_A = '10000000-0000-4000-8000-000000000001'      // owner at a location in org A
const OWNER_B = '10000000-0000-4000-8000-000000000002'      // owner at a location in org B
const MASTER = '10000000-0000-4000-8000-000000000003'
const MANAGER_A = '10000000-0000-4000-8000-000000000004'    // never writes policies
const INACTIVE_OWNER_A = '10000000-0000-4000-8000-000000000005'
const ORG_ADMIN_A = '10000000-0000-4000-8000-000000000006'  // owner via a profile_organizations grant only
const STRANGER = '10000000-0000-4000-8000-000000000007'     // owner role, member of nothing

const POLICY_A = '20000000-0000-4000-8000-00000000000a'
const POLICY_B = '20000000-0000-4000-8000-00000000000b'
const VERSION_A = '30000000-0000-4000-8000-00000000000a'
const VERSION_B = '30000000-0000-4000-8000-00000000000b'

const BASE_SCHEMA = `
  CREATE ROLE anon NOLOGIN;
  CREATE ROLE authenticated NOLOGIN;
  CREATE SCHEMA auth;
  CREATE SCHEMA private;
  GRANT USAGE ON SCHEMA auth, private, public TO authenticated, anon;

  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
    SELECT nullif(current_setting('request.jwt.claims', true)::json->>'sub', '')::uuid
  $$;
  GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated, anon;

  CREATE TABLE public.organizations (id uuid PRIMARY KEY);
  CREATE TABLE public.locations (
    id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES public.organizations(id)
  );
  CREATE TABLE public.profiles (
    id uuid PRIMARY KEY, role text NOT NULL, active boolean DEFAULT true, deleted_at timestamptz
  );
  CREATE TABLE public.profile_locations (
    profile_id uuid REFERENCES public.profiles(id),
    location_id uuid REFERENCES public.locations(id),
    role text NOT NULL,
    PRIMARY KEY (profile_id, location_id)
  );
  CREATE TABLE public.profile_organizations (
    profile_id uuid REFERENCES public.profiles(id),
    organization_id uuid REFERENCES public.organizations(id),
    PRIMARY KEY (profile_id, organization_id)
  );
  -- policies as mig 713 left it (organization_id NOT NULL, slug unique per org).
  CREATE TABLE public.policies (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id uuid NOT NULL REFERENCES public.organizations(id),
    slug text NOT NULL,
    title text NOT NULL,
    active boolean NOT NULL DEFAULT true,
    UNIQUE (organization_id, slug)
  );
  CREATE TABLE public.policy_versions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    policy_id uuid NOT NULL REFERENCES public.policies(id) ON DELETE CASCADE,
    version_number integer NOT NULL,
    body_markdown text NOT NULL,
    change_summary text,
    effective_date date NOT NULL DEFAULT current_date,
    UNIQUE (policy_id, version_number)
  );

  GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated;

  -- Helpers as mig 626 left them.
  CREATE FUNCTION private.auth_is_active_staff() RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
    SELECT EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = (SELECT auth.uid()) AND active IS NOT FALSE AND deleted_at IS NULL)
  $$;
  CREATE FUNCTION private.auth_is_master() RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
    SELECT EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = (SELECT auth.uid()) AND role = 'master' AND active IS NOT FALSE AND deleted_at IS NULL)
  $$;
  CREATE FUNCTION private.auth_is_in_organization(org_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
    SELECT org_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.id = (SELECT auth.uid())
          AND p.active IS NOT FALSE
          AND p.deleted_at IS NULL
          AND (
            p.role = 'master'
            OR EXISTS (
              SELECT 1 FROM public.locations l
                JOIN public.profile_locations pl ON pl.location_id = l.id
               WHERE l.organization_id = org_id AND pl.profile_id = (SELECT auth.uid()))
            OR EXISTS (
              SELECT 1 FROM public.profile_organizations po
               WHERE po.organization_id = org_id AND po.profile_id = (SELECT auth.uid()))))
  $$;
  GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA private TO authenticated;

  ALTER TABLE public.policies ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.policy_versions ENABLE ROW LEVEL SECURITY;
`

// The six write policies exactly as mig 626 left them (mig 320 shape + the
// active-staff gate), plus the two org-scoped read policies from mig 713.
const POLICIES_BEFORE_714 = `
  CREATE POLICY "policies_ins" ON public.policies FOR INSERT TO authenticated
    WITH CHECK (EXISTS ( SELECT 1 FROM profiles p WHERE p.id = (select auth.uid()) AND (p.role = 'master'::text OR p.role = 'owner'::text) AND (SELECT private.auth_is_active_staff())));
  CREATE POLICY "policies_upd" ON public.policies FOR UPDATE TO authenticated
    USING (EXISTS ( SELECT 1 FROM profiles p WHERE p.id = (select auth.uid()) AND (p.role = 'master'::text OR p.role = 'owner'::text) AND (SELECT private.auth_is_active_staff())))
    WITH CHECK (EXISTS ( SELECT 1 FROM profiles p WHERE p.id = (select auth.uid()) AND (p.role = 'master'::text OR p.role = 'owner'::text) AND (SELECT private.auth_is_active_staff())));
  CREATE POLICY "policies_del" ON public.policies FOR DELETE TO authenticated
    USING (EXISTS ( SELECT 1 FROM profiles p WHERE p.id = (select auth.uid()) AND (p.role = 'master'::text OR p.role = 'owner'::text) AND (SELECT private.auth_is_active_staff())));

  CREATE POLICY "policy_versions_ins" ON public.policy_versions FOR INSERT TO authenticated
    WITH CHECK (EXISTS ( SELECT 1 FROM profiles p WHERE p.id = (select auth.uid()) AND (p.role = 'master'::text OR p.role = 'owner'::text) AND (SELECT private.auth_is_active_staff())));
  CREATE POLICY "policy_versions_upd" ON public.policy_versions FOR UPDATE TO authenticated
    USING (EXISTS ( SELECT 1 FROM profiles p WHERE p.id = (select auth.uid()) AND (p.role = 'master'::text OR p.role = 'owner'::text) AND (SELECT private.auth_is_active_staff())))
    WITH CHECK (EXISTS ( SELECT 1 FROM profiles p WHERE p.id = (select auth.uid()) AND (p.role = 'master'::text OR p.role = 'owner'::text) AND (SELECT private.auth_is_active_staff())));
  CREATE POLICY "policy_versions_del" ON public.policy_versions FOR DELETE TO authenticated
    USING (EXISTS ( SELECT 1 FROM profiles p WHERE p.id = (select auth.uid()) AND (p.role = 'master'::text OR p.role = 'owner'::text) AND (SELECT private.auth_is_active_staff())));

  CREATE POLICY policies_read_in_org ON public.policies
    FOR SELECT TO authenticated
    USING (private.auth_is_master() OR private.auth_is_in_organization(organization_id));
  CREATE POLICY policy_versions_read_in_org ON public.policy_versions
    FOR SELECT TO authenticated
    USING (EXISTS (
      SELECT 1 FROM public.policies p
       WHERE p.id = policy_versions.policy_id
         AND (private.auth_is_master() OR private.auth_is_in_organization(p.organization_id))));
`

const SEED = `
  INSERT INTO public.organizations VALUES ('${ORG_A}'), ('${ORG_B}');
  INSERT INTO public.locations VALUES ('${LOC_A}', '${ORG_A}'), ('${LOC_B}', '${ORG_B}');
  INSERT INTO public.profiles (id, role, active) VALUES
    ('${OWNER_A}', 'owner', true), ('${OWNER_B}', 'owner', true), ('${MASTER}', 'master', true),
    ('${MANAGER_A}', 'manager', true), ('${INACTIVE_OWNER_A}', 'owner', false),
    ('${ORG_ADMIN_A}', 'owner', true), ('${STRANGER}', 'owner', true);
  INSERT INTO public.profile_locations VALUES
    ('${OWNER_A}', '${LOC_A}', 'owner'), ('${OWNER_B}', '${LOC_B}', 'owner'),
    ('${MANAGER_A}', '${LOC_A}', 'manager'), ('${INACTIVE_OWNER_A}', '${LOC_A}', 'owner');
  INSERT INTO public.profile_organizations VALUES ('${ORG_ADMIN_A}', '${ORG_A}');
  INSERT INTO public.policies (id, organization_id, slug, title) VALUES
    ('${POLICY_A}', '${ORG_A}', 'employee-handbook', 'Handbook A'),
    ('${POLICY_B}', '${ORG_B}', 'employee-handbook', 'Handbook B');
  INSERT INTO public.policy_versions (id, policy_id, version_number, body_markdown) VALUES
    ('${VERSION_A}', '${POLICY_A}', 1, 'a'),
    ('${VERSION_B}', '${POLICY_B}', 1, 'b');
`

let db
// PGlite's multi-statement SQL runner (a database call, no shell involved).
const runSql = (text) => db.exec(text)

/** Run `sql` as an authenticated JWT for `uid` inside a rolled-back tx. */
async function asUser(uid, sql, params = []) {
  await runSql('BEGIN')
  try {
    await db.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: uid, role: 'authenticated' })])
    await runSql('SET LOCAL ROLE authenticated')
    return await db.query(sql, params)
  } finally {
    await runSql('ROLLBACK')
  }
}

const RLS = /row-level security/

const insertPolicyAs = (uid, org) =>
  asUser(uid, `INSERT INTO public.policies (organization_id, slug, title) VALUES ($1, 'new-policy', 'New')`, [org])
const updatePolicyAs = async (uid, id) =>
  (await asUser(uid, `UPDATE public.policies SET title = 'renamed' WHERE id = $1`, [id])).affectedRows
const movePolicyAs = (uid, id, org) =>
  asUser(uid, `UPDATE public.policies SET organization_id = $2, slug = 'moved' WHERE id = $1`, [id, org])
const deletePolicyAs = async (uid, id) =>
  (await asUser(uid, `DELETE FROM public.policies WHERE id = $1`, [id])).affectedRows

const insertVersionAs = (uid, policyId) =>
  asUser(uid, `INSERT INTO public.policy_versions (policy_id, version_number, body_markdown) VALUES ($1, 2, 'v2')`, [policyId])
const updateVersionAs = async (uid, id) =>
  (await asUser(uid, `UPDATE public.policy_versions SET change_summary = 'edited' WHERE id = $1`, [id])).affectedRows
const moveVersionAs = (uid, id, policyId) =>
  asUser(uid, `UPDATE public.policy_versions SET policy_id = $2, version_number = 9 WHERE id = $1`, [id, policyId])
const deleteVersionAs = async (uid, id) =>
  (await asUser(uid, `DELETE FROM public.policy_versions WHERE id = $1`, [id])).affectedRows

beforeEach(async () => {
  db = new PGlite()
  await runSql(BASE_SCHEMA)
  await runSql(POLICIES_BEFORE_714)
  await runSql(SEED)
}, 60_000)

afterEach(async () => { await db?.close() })

// PGlite boots per test; a cold boot on a loaded runner can pass 5 s.
describe('before 714 — the leak is real (guards against a vacuous pass)', { timeout: 30_000 }, () => {
  it('an owner in org A inserts into org B, and the owner of org B has no say', async () => {
    await expect(insertPolicyAs(OWNER_A, ORG_B)).resolves.toBeTruthy()
    await expect(insertVersionAs(OWNER_B, POLICY_A)).resolves.toBeTruthy()
  })

  it('a stranger who is an owner nowhere still inserts anywhere', async () => {
    await expect(insertPolicyAs(STRANGER, ORG_A)).resolves.toBeTruthy()
  })
})

describe('after 714 — policies', { timeout: 30_000 }, () => {
  beforeEach(async () => { await runSql(MIG_714) })

  it('an owner writes only in their own organisation', async () => {
    await expect(insertPolicyAs(OWNER_A, ORG_A)).resolves.toBeTruthy()
    await expect(insertPolicyAs(OWNER_A, ORG_B)).rejects.toThrow(RLS)
    expect(await updatePolicyAs(OWNER_A, POLICY_A)).toBe(1)
    expect(await updatePolicyAs(OWNER_A, POLICY_B)).toBe(0)
    expect(await deletePolicyAs(OWNER_A, POLICY_A)).toBe(1)
    expect(await deletePolicyAs(OWNER_A, POLICY_B)).toBe(0)
  })

  it('an owner cannot move a policy into another organisation (UPDATE WITH CHECK)', async () => {
    await expect(movePolicyAs(OWNER_A, POLICY_A, ORG_B)).rejects.toThrow(RLS)
  })

  it('an owner via a profile_organizations grant writes in that organisation only', async () => {
    await expect(insertPolicyAs(ORG_ADMIN_A, ORG_A)).resolves.toBeTruthy()
    await expect(insertPolicyAs(ORG_ADMIN_A, ORG_B)).rejects.toThrow(RLS)
    expect(await updatePolicyAs(ORG_ADMIN_A, POLICY_A)).toBe(1)
    expect(await updatePolicyAs(ORG_ADMIN_A, POLICY_B)).toBe(0)
  })

  it('master is unchanged: writes everywhere, may move a policy between organisations', async () => {
    await expect(insertPolicyAs(MASTER, ORG_A)).resolves.toBeTruthy()
    await expect(insertPolicyAs(MASTER, ORG_B)).resolves.toBeTruthy()
    expect(await updatePolicyAs(MASTER, POLICY_A)).toBe(1)
    expect(await updatePolicyAs(MASTER, POLICY_B)).toBe(1)
    await expect(movePolicyAs(MASTER, POLICY_A, ORG_B)).resolves.toBeTruthy()
    expect(await deletePolicyAs(MASTER, POLICY_B)).toBe(1)
  })

  it('a manager, a deactivated owner and an owner of nothing write nothing', async () => {
    for (const uid of [MANAGER_A, INACTIVE_OWNER_A, STRANGER]) {
      await expect(insertPolicyAs(uid, ORG_A)).rejects.toThrow(RLS)
      expect(await updatePolicyAs(uid, POLICY_A)).toBe(0)
      expect(await deletePolicyAs(uid, POLICY_A)).toBe(0)
    }
  })
})

describe('after 714 — policy_versions (scoped through the parent policy)', { timeout: 30_000 }, () => {
  beforeEach(async () => { await runSql(MIG_714) })

  it('an owner publishes, edits and deletes versions of their own organisation\'s policies only', async () => {
    await expect(insertVersionAs(OWNER_A, POLICY_A)).resolves.toBeTruthy()
    await expect(insertVersionAs(OWNER_A, POLICY_B)).rejects.toThrow(RLS)
    expect(await updateVersionAs(OWNER_A, VERSION_A)).toBe(1)
    expect(await updateVersionAs(OWNER_A, VERSION_B)).toBe(0)
    expect(await deleteVersionAs(OWNER_A, VERSION_A)).toBe(1)
    expect(await deleteVersionAs(OWNER_A, VERSION_B)).toBe(0)
  })

  it('an owner cannot re-parent a version under another organisation\'s policy (UPDATE WITH CHECK)', async () => {
    await expect(moveVersionAs(OWNER_A, VERSION_A, POLICY_B)).rejects.toThrow(RLS)
  })

  it('master is unchanged on versions too', async () => {
    await expect(insertVersionAs(MASTER, POLICY_B)).resolves.toBeTruthy()
    expect(await updateVersionAs(MASTER, VERSION_A)).toBe(1)
    expect(await updateVersionAs(MASTER, VERSION_B)).toBe(1)
    await expect(moveVersionAs(MASTER, VERSION_A, POLICY_B)).resolves.toBeTruthy()
    expect(await deleteVersionAs(MASTER, VERSION_B)).toBe(1)
  })

  it('a manager, a deactivated owner and an owner of nothing write no version', async () => {
    for (const uid of [MANAGER_A, INACTIVE_OWNER_A, STRANGER]) {
      await expect(insertVersionAs(uid, POLICY_A)).rejects.toThrow(RLS)
      expect(await updateVersionAs(uid, VERSION_A)).toBe(0)
      expect(await deleteVersionAs(uid, VERSION_A)).toBe(0)
    }
  })
})

describe('mig 714 — the file itself', { timeout: 30_000 }, () => {
  it('replays cleanly (DROP IF EXISTS then CREATE)', async () => {
    await runSql(MIG_714)
    await runSql(MIG_714)
    await expect(insertPolicyAs(OWNER_A, ORG_B)).rejects.toThrow(RLS)
  })

  it('leaves exactly four permissive policies per table, one per command, and the read policies untouched', async () => {
    await runSql(MIG_714)
    const { rows } = await db.query(`
      SELECT tablename, policyname, permissive, cmd FROM pg_policies
      WHERE schemaname = 'public' AND tablename IN ('policies', 'policy_versions')
      ORDER BY tablename, policyname`)
    expect(rows).toEqual([
      { tablename: 'policies', policyname: 'policies_del', permissive: 'PERMISSIVE', cmd: 'DELETE' },
      { tablename: 'policies', policyname: 'policies_ins', permissive: 'PERMISSIVE', cmd: 'INSERT' },
      { tablename: 'policies', policyname: 'policies_read_in_org', permissive: 'PERMISSIVE', cmd: 'SELECT' },
      { tablename: 'policies', policyname: 'policies_upd', permissive: 'PERMISSIVE', cmd: 'UPDATE' },
      { tablename: 'policy_versions', policyname: 'policy_versions_del', permissive: 'PERMISSIVE', cmd: 'DELETE' },
      { tablename: 'policy_versions', policyname: 'policy_versions_ins', permissive: 'PERMISSIVE', cmd: 'INSERT' },
      { tablename: 'policy_versions', policyname: 'policy_versions_read_in_org', permissive: 'PERMISSIVE', cmd: 'SELECT' },
      { tablename: 'policy_versions', policyname: 'policy_versions_upd', permissive: 'PERMISSIVE', cmd: 'UPDATE' },
    ])
  })

  it('every write clause names auth_is_in_organization and keeps the active-staff gate', async () => {
    await runSql(MIG_714)
    const { rows } = await db.query(`
      SELECT policyname, qual, with_check FROM pg_policies
      WHERE schemaname = 'public' AND tablename IN ('policies', 'policy_versions')
        AND cmd <> 'SELECT'`)
    expect(rows).toHaveLength(6)
    for (const r of rows) {
      for (const clause of [r.qual, r.with_check].filter(Boolean)) {
        expect(clause, r.policyname).toMatch(/auth_is_in_organization/)
        expect(clause, r.policyname).toMatch(/auth_is_active_staff/)
      }
    }
  })

  it('the self-check aborts the WHOLE file when one policy is not narrowed', async () => {
    // Break only the DELETE policy on policies: it keeps the mig-626 predicate.
    const broken = MIG_714.replace(
      /(CREATE POLICY "policies_del" ON public\.policies FOR DELETE TO authenticated\s+USING \()[\s\S]*?(\n  \);)/,
      `$1EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = (select auth.uid()) AND p.role IN ('master','owner') AND (SELECT private.auth_is_active_staff()))$2`,
    )
    expect(broken).not.toBe(MIG_714)
    await expect(runSql(broken)).rejects.toThrow(/W0\.5b/)
    await runSql('ROLLBACK')
    // Nothing landed: the org-A owner still inserts into org B (the pre-714 state).
    await expect(insertPolicyAs(OWNER_A, ORG_B)).resolves.toBeTruthy()
  })
})
