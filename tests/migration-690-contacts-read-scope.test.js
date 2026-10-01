// CONTACTREADSCOPE.1b — behavioural test for migration 690.
//
// No local Supabase stack exists, so the DDL would otherwise get its first
// run on prod. This boots PGlite (PostgreSQL 17) through the C101 harness
// (tests/helpers/member-write-sweep.js: Supabase's pre-677 default
// privileges, the real 677 file for prod's state since 30 Sep, the private
// helpers verbatim) and adds what prod holds on 2 Oct 2026 for this row:
// contacts SELECT for authenticated only, its one policy contacts_select
// (membership OR own row) verbatim, the real Contacts inputs
// (locations.features, private.permission_key_bundles, profile_locations
// .permissions, location_role_permissions incl. employment-type rows,
// profiles.employment_type), and three tables whose policies read contacts
// as the caller (contact_goals_read and challenges_read verbatim, a deals
// read standing in for any embed). Then the REAL 690 file, and:
//   * the contractor case: Contacts off by template -> 5 contacts before, 0
//     after; a staff member who is also a member -> own row only;
//   * everyone who holds Contacts reads exactly what they did; members
//     unchanged; masters every studio whose switch/bundle is on; a
//     deactivated or tombstoned profile reads no studio;
//   * the studio switch and the bundle bind masters too;
//   * a child table's staff branch narrows with it; the member branch and
//     challenges_read do not; an embed comes back NULL, the parent row stays;
//   * the helper is an InitPlan: evaluated once per statement (EXPLAIN);
//   * THE PARITY MATRIX: 4,544 combinations of role, studio switch, bundle,
//     per-user override (web/phone), 'all' template, employment-type
//     template and employment type, where the SQL helper must agree with the
//     real hasPermissionForLocation || hasMobilePermissionForLocation;
//   * EXECUTE: authenticated + service_role only; anon still holds nothing on
//     contacts; the policy's shape and text; idempotent; abort cases; the
//     rollback record (POST-677 form).
// Fictional ids only: the repo is public.

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { boot, asUser, asRole, IDS, abortMessage, policiesOf } from './helpers/member-write-sweep.js'
import { hasPermissionForLocation, hasMobilePermissionForLocation } from '../src/lib/permissions.js'
import { mergeTemplates } from '../shared/permissions.js'

const MIG_690 = readFileSync(path.resolve(import.meta.dirname,
  '../supabase/migrations/690_contacts_read_needs_contacts_permission.sql'), 'utf8')

// pg_policies.qual, verbatim from prod (2 Oct 2026, md5 94ddf7a3…).
const OLD_QUAL = '(private.auth_is_in_location(location_id) OR (user_id = ( SELECT auth.uid() AS uid)))'
// How PostgreSQL 17 deparses 690's USING. The ::uuid[] is load-bearing:
// `x = ANY ((SELECT f()))` parses as `x = ANY (subquery)` (a set of uuid[]
// rows; "operator does not exist: uuid = uuid[]"), so the file casts the
// scalar subquery, and the deparse keeps the cast for the same reason.
const NEW_QUAL = '((location_id = ANY (( SELECT private.auth_contact_read_location_ids() AS auth_contact_read_location_ids)::uuid[])) OR (user_id = ( SELECT auth.uid() AS uid)))'

// The rollback record (plan Task 1b-5 Step 6), POST-677 form: 690 changes no
// privilege, so the rollback re-issues none.
const ROLLBACK_690 = `
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER POLICY contacts_select ON public.contacts
  USING (private.auth_is_in_location(location_id) OR (user_id = (SELECT auth.uid())));
DROP FUNCTION IF EXISTS private.auth_contact_read_location_ids();
COMMIT;
`

const { LOC_A, LOC_B } = IDS
const LOC_P = 'c0000000-0000-0000-0000-00000000000c'   // the parity matrix's studio
const PROBE = '10000000-0000-0000-0000-0000000000ff'   // the parity matrix's login
const GONE = '10000000-0000-0000-0000-0000000000ee'    // an owner at A, deactivated / tombstoned per test
const C_A1 = '30000000-0000-0000-0000-0000000000a1'
const C_A2 = '30000000-0000-0000-0000-0000000000a2'

const TABLES = `
  ALTER TABLE public.locations ADD COLUMN features jsonb DEFAULT '{}'::jsonb;
  ALTER TABLE public.profiles ADD COLUMN employment_type text;
  ALTER TABLE public.profile_locations ADD COLUMN permissions jsonb DEFAULT '{}'::jsonb;
  CREATE TABLE public.location_role_permissions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), location_id uuid NOT NULL, role text NOT NULL,
    employment_type text NOT NULL DEFAULT 'all', permissions jsonb NOT NULL DEFAULT '{}'::jsonb,
    UNIQUE (location_id, role, employment_type));
  REVOKE ALL ON public.location_role_permissions FROM anon, authenticated;
  CREATE TABLE private.permission_key_bundles (key text NOT NULL, bundle text NOT NULL, PRIMARY KEY (key, bundle));
  INSERT INTO private.permission_key_bundles VALUES ('contacts', 'bundle_sales'), ('pipeline', 'bundle_sales');

  -- contacts as prod has it post-653/657/677: authenticated SELECT only.
  GRANT SELECT ON public.contacts TO authenticated;

  CREATE TABLE public.contact_goals (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), contact_id uuid NOT NULL);
  CREATE TABLE public.challenges (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), location_id uuid NOT NULL, ends_on date NOT NULL);
  CREATE TABLE public.deals (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), location_id uuid NOT NULL, contact_id uuid, title text);
  REVOKE ALL ON public.contact_goals, public.challenges, public.deals FROM anon, authenticated;
  GRANT SELECT ON public.contact_goals, public.challenges, public.deals TO authenticated;
`

// Verbatim from prod (pg_policies, 1 Oct 2026), except deals_select, a
// stand-in: any staff-readable table whose select embeds contacts.
const POLICIES = `
  ALTER TABLE public.contacts ENABLE ROW LEVEL SECURITY;
  CREATE POLICY contacts_select ON public.contacts FOR SELECT TO public
    USING (private.auth_is_in_location(location_id) OR (user_id = (SELECT auth.uid())));
  ALTER TABLE public.contact_goals ENABLE ROW LEVEL SECURITY;
  CREATE POLICY contact_goals_read ON public.contact_goals FOR SELECT TO public
    USING ((contact_id = private.auth_contact_id()) OR (private.auth_is_master() OR (EXISTS (SELECT 1 FROM contacts c
      WHERE ((c.id = contact_goals.contact_id) AND private.auth_is_in_location(c.location_id))))));
  ALTER TABLE public.challenges ENABLE ROW LEVEL SECURITY;
  CREATE POLICY challenges_read ON public.challenges FOR SELECT TO public
    USING ((SELECT private.auth_is_master()) OR private.auth_is_in_location(location_id)
      OR ((ends_on >= ((now() AT TIME ZONE 'Europe/Dublin')::date - 14))
          AND EXISTS (SELECT 1 FROM contacts c WHERE c.id = (SELECT private.auth_contact_id())
                        AND c.location_id = challenges.location_id)));
  ALTER TABLE public.deals ENABLE ROW LEVEL SECURITY;
  CREATE POLICY deals_select ON public.deals FOR SELECT TO authenticated USING (private.auth_is_in_location(location_id));
`

const SEED = `
  INSERT INTO public.locations (id) VALUES ('${LOC_P}');
  INSERT INTO public.profiles (id, role) VALUES ('${PROBE}', 'staff'), ('${GONE}', 'owner');
  INSERT INTO public.profile_locations (profile_id, location_id, role) VALUES ('${GONE}', '${LOC_A}', 'owner');
  INSERT INTO public.contacts (id, location_id, user_id) VALUES ('${C_A1}', '${LOC_A}', NULL), ('${C_A2}', '${LOC_A}', NULL);
  INSERT INTO public.contact_goals (contact_id) VALUES ('${IDS.C_MEMBER}'), ('${C_A1}');
  INSERT INTO public.challenges (location_id, ends_on) VALUES ('${LOC_A}', current_date + 7);
  INSERT INTO public.deals (location_id, contact_id, title) VALUES ('${LOC_A}', '${C_A1}', 'Synth deal');
  -- the prod shape: contractor staff at A, Contacts off on web and phone by template
  UPDATE public.profiles SET employment_type = 'contractor' WHERE id = '${IDS.STAFF_A}';
  INSERT INTO public.location_role_permissions (location_id, role, employment_type, permissions)
    VALUES ('${LOC_A}', 'staff', 'contractor', '{"contacts": false, "mobile": {"contacts": false}}');
  -- a staff member who is also a member, Contacts off by their own override
  UPDATE public.profile_locations SET permissions = '{"contacts": false, "mobile": {"contacts": false}}'
   WHERE profile_id = '${IDS.STAFF_MEMBER}';
`

const visible = async (db, uid) => (await asUser(db, uid, 'SELECT count(*)::int AS n FROM public.contacts'))[0].n
const ownRows = async (db, uid) => (await asUser(db, uid,
  'SELECT count(*)::int AS n FROM public.contacts WHERE user_id = (SELECT auth.uid())'))[0].n
const countOf = async (db, uid, table) => (await asUser(db, uid, `SELECT count(*)::int AS n FROM public.${table}`))[0].n
// The harness's auth.uid() casts request.jwt.claims straight to json, and a
// claims GUC first set inside asUser's rolled-back transaction reads '' (not
// NULL) afterwards, which that cast refuses (prod's auth.uid() nullifies '').
// Re-running the file after a signed-in read therefore starts from an
// explicit signed-out session, as the MCP apply session is.
const signedOut = (db) => db.query(`SELECT set_config('request.jwt.claims', '{}', false)`)
const bootProd = (opts = {}) => boot({ tables: TABLES, policies: POLICIES, seed: SEED, after677: true, ...opts })

describe('before 690: prod on 2 Oct 2026', () => {
  let db
  beforeAll(async () => { db = await bootProd() }, 60_000)
  afterAll(() => db?.close())

  it('membership is enough: the contractor with Contacts off reads the whole studio', async () => {
    expect(await visible(db, IDS.STAFF_A)).toBe(5)
    expect(await visible(db, IDS.STAFF_MEMBER)).toBe(5)
    expect(await countOf(db, IDS.STAFF_A, 'contact_goals')).toBe(2)
  })

  it('the policy is the prod text', async () => {
    const [p] = await policiesOf(db, ['contacts'])
    expect(p.qual).toBe(OLD_QUAL)
  })
})

describe('after 690', () => {
  let db
  beforeAll(async () => { db = await bootProd({ migrate: [MIG_690] }) }, 60_000)
  afterAll(() => db?.close())

  it('the contractor with Contacts off reads nothing; the staff member who is a member reads only their own row', async () => {
    expect(await visible(db, IDS.STAFF_A)).toBe(0)
    expect(await visible(db, IDS.STAFF_MEMBER)).toBe(1)
    expect(await ownRows(db, IDS.STAFF_MEMBER)).toBe(1)
  })

  it('Contacts holders read exactly what they did; members their own row; master everything', async () => {
    expect(await visible(db, IDS.OWNER_A)).toBe(5)
    expect(await visible(db, IDS.STAFF_B)).toBe(1)
    expect(await visible(db, IDS.MASTER)).toBe(6)
    expect(await visible(db, IDS.MEMBER_UID)).toBe(1)
    expect(await ownRows(db, IDS.MEMBER_UID)).toBe(1)
  })

  it('a deactivated or tombstoned profile reads no studio (the mig 626 rule)', async () => {
    expect(await visible(db, GONE)).toBe(5)
    await db.query(`UPDATE public.profiles SET active = false WHERE id = $1`, [GONE])
    expect(await visible(db, GONE)).toBe(0)
    await db.query(`UPDATE public.profiles SET active = NULL, deleted_at = now() WHERE id = $1`, [GONE])
    expect(await visible(db, GONE)).toBe(0)
    await db.query(`UPDATE public.profiles SET active = NULL, deleted_at = NULL WHERE id = $1`, [GONE])
    expect(await visible(db, GONE)).toBe(5)   // NULL active counts as active, as in the app
  })

  it('a phone-only Contacts holder still reads (either toggle admits)', async () => {
    await db.query(`UPDATE public.profile_locations SET permissions = '{"contacts": false}' WHERE profile_id = $1`, [IDS.OWNER_A])
    expect(await visible(db, IDS.OWNER_A)).toBe(5)
    await db.query(`UPDATE public.profile_locations SET permissions = '{"contacts": false, "mobile": {"contacts": false}}' WHERE profile_id = $1`, [IDS.OWNER_A])
    expect(await visible(db, IDS.OWNER_A)).toBe(0)
    await db.query(`UPDATE public.profile_locations SET permissions = '{"mobile": {"contacts": false}}' WHERE profile_id = $1`, [IDS.OWNER_A])
    expect(await visible(db, IDS.OWNER_A)).toBe(5)   // web-only holder too
    await db.query(`UPDATE public.profile_locations SET permissions = '{}' WHERE profile_id = $1`, [IDS.OWNER_A])
  })

  it('the per-user override beats the template: a contractor switched back on reads again', async () => {
    await db.query(`UPDATE public.profile_locations SET permissions = '{"mobile": {"contacts": true}}' WHERE profile_id = $1`, [IDS.STAFF_A])
    expect(await visible(db, IDS.STAFF_A)).toBe(5)
    await db.query(`UPDATE public.profile_locations SET permissions = '{}' WHERE profile_id = $1`, [IDS.STAFF_A])
    expect(await visible(db, IDS.STAFF_A)).toBe(0)
  })

  it('the studio switch and the bundle bind masters too', async () => {
    for (const features of ['{"contacts": false}', '{"bundle_sales": false}']) {
      await db.query(`UPDATE public.locations SET features = $1::jsonb WHERE id = $2`, [features, LOC_B])
      expect(await visible(db, IDS.STAFF_B)).toBe(0)
      expect(await visible(db, IDS.MASTER)).toBe(5)
    }
    await db.query(`UPDATE public.locations SET features = '{"contacts": true, "bundle_sales": false}'::jsonb WHERE id = $1`, [LOC_B])
    expect(await visible(db, IDS.STAFF_B)).toBe(0) // bundle off denies even with the key on (bundlesDenyKey)
    await db.query(`UPDATE public.locations SET features = NULL WHERE id = $1`, [LOC_B])
    expect(await visible(db, IDS.STAFF_B)).toBe(1) // no features at all = nothing switched off
    await db.query(`UPDATE public.locations SET features = '{}'::jsonb WHERE id = $1`, [LOC_B])
    expect(await visible(db, IDS.STAFF_B)).toBe(1)
  })

  it("a child table's staff branch narrows with it; members and challenges_read are unchanged", async () => {
    expect(await countOf(db, IDS.STAFF_A, 'contact_goals')).toBe(0)
    expect(await countOf(db, IDS.OWNER_A, 'contact_goals')).toBe(2)
    expect(await countOf(db, IDS.MEMBER_UID, 'contact_goals')).toBe(1)
    expect(await countOf(db, IDS.MEMBER_UID, 'challenges')).toBe(1)
    expect(await countOf(db, IDS.STAFF_A, 'challenges')).toBe(1)
  })

  it('an embed comes back NULL, never an error, and the parent row stays', async () => {
    const q = `SELECT d.title, c.id AS contact FROM public.deals d LEFT JOIN public.contacts c ON c.id = d.contact_id`
    expect(await asUser(db, IDS.STAFF_A, q)).toEqual([{ title: 'Synth deal', contact: null }])
    expect(await asUser(db, IDS.OWNER_A, q)).toEqual([{ title: 'Synth deal', contact: C_A1 }])
  })

  it('the helper is an InitPlan, run once per statement, never a per-row SubPlan', async () => {
    const rows = await asUser(db, IDS.OWNER_A,
      `EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY OFF) SELECT id FROM public.contacts WHERE location_id = '${LOC_A}'`)
    const plan = rows.map((r) => r['QUERY PLAN']).join('\n')
    expect(plan).not.toMatch(/SubPlan/)
    expect(plan).not.toMatch(/auth_is_in_location/)
    // the policy's array is an InitPlan's output, and that InitPlan ran once
    const n = plan.match(/location_id = ANY \(\(InitPlan (\d+)\)\.col1\)/)?.[1]
    expect(n, plan).toBeTruthy()
    const lines = plan.split('\n')
    const i = lines.findIndex((l) => l.trim() === `InitPlan ${n}`)
    expect(lines[i + 1], plan).toMatch(/\bloops=1\b/)
  })

  it('EXECUTE: authenticated and service_role only; anon still holds nothing on contacts', async () => {
    const { rows: [r] } = await db.query(`SELECT
        has_function_privilege('authenticated', 'private.auth_contact_read_location_ids()', 'EXECUTE') a,
        has_function_privilege('service_role', 'private.auth_contact_read_location_ids()', 'EXECUTE') s,
        has_function_privilege('anon', 'private.auth_contact_read_location_ids()', 'EXECUTE') n,
        has_table_privilege('anon', 'public.contacts', 'SELECT') anon_sel`)
    expect(r).toEqual({ a: true, s: true, n: false, anon_sel: false })
    await expect(asRole(db, 'anon', 'SELECT id FROM public.contacts')).rejects.toThrow(/permission denied for table contacts/)
  })

  it('the helper is SECURITY DEFINER, STABLE, search_path pinned empty, returns uuid[]', async () => {
    const { rows: [r] } = await db.query(`SELECT prosecdef d, provolatile v, proconfig c, prorettype::regtype::text t
      FROM pg_proc WHERE oid = to_regprocedure('private.auth_contact_read_location_ids()')`)
    expect(r).toEqual({ d: true, v: 's', c: ['search_path=""'], t: 'uuid[]' })
  })

  it('one policy, same name/command/roles, the new USING, no WITH CHECK', async () => {
    const ps = await policiesOf(db, ['contacts'])
    expect(ps).toEqual([{ tablename: 'contacts', policyname: 'contacts_select', permissive: 'PERMISSIVE',
      cmd: 'SELECT', roles: '{public}', qual: NEW_QUAL, with_check: null }])
  })

  it('a second run passes and changes nothing', async () => {
    await signedOut(db)
    await expect(db['exec'](MIG_690)).resolves.toBeDefined()
    expect(await visible(db, IDS.STAFF_A)).toBe(0)
    expect(await visible(db, IDS.OWNER_A)).toBe(5)
    expect((await policiesOf(db, ['contacts']))[0].qual).toBe(NEW_QUAL)
  })
})

describe('THE PARITY MATRIX: SQL helper === real JS resolver (web OR phone Contacts)', () => {
  let db
  const mismatches = []
  let cases = 0
  const answers = { true: 0, false: 0 }
  beforeAll(async () => {
    db = await bootProd({ migrate: [MIG_690] })
    // 'guest' stands for any role the JS maps do not know: default no.
    const ROLES = [null, 'owner', 'manager', 'head_coach', 'staff', 'reception', 'guest']
    const FEATURES = [{}, { contacts: false }, { bundle_sales: false }, { contacts: true, bundle_sales: false }]
    const OVERRIDES = [{}, { contacts: false }, { contacts: true }, { mobile: { contacts: false } },
      { contacts: false, mobile: { contacts: false } }, { contacts: false, mobile: { contacts: true } }]
    const TPL_ALL = [null, { contacts: false }, { contacts: false, mobile: { contacts: false } }]
    const TPL_VAR = [null, { contacts: true }, { contacts: false, mobile: { contacts: false } }]
    // the variant row is keyed 'contractor'; an 'fte' login must not get it
    const EMP = [null, 'contractor', 'fte']
    const all = []
    for (const features of FEATURES) {
      all.push({ master: true, plRole: null, features, override: {}, tplAll: null, tplVar: null, emp: null })
      all.push({ master: true, plRole: 'owner', features, override: { contacts: false, mobile: { contacts: false } }, tplAll: null, tplVar: null, emp: null })
      for (const plRole of ROLES) for (const override of OVERRIDES) for (const tplAll of TPL_ALL)
        for (const tplVar of TPL_VAR) for (const emp of EMP)
          all.push({ master: false, plRole, features, override, tplAll, tplVar, emp })
    }
    for (const c of all) {
      await db.query(`UPDATE public.locations SET features = $1::jsonb WHERE id = $2`, [JSON.stringify(c.features), LOC_P])
      await db.query(`UPDATE public.profiles SET role = $1, employment_type = $2 WHERE id = $3`, [c.master ? 'master' : 'staff', c.emp, PROBE])
      await db.query(`DELETE FROM public.profile_locations WHERE profile_id = $1`, [PROBE])
      await db.query(`DELETE FROM public.location_role_permissions WHERE location_id = $1`, [LOC_P])
      if (c.plRole) {
        await db.query(`INSERT INTO public.profile_locations (profile_id, location_id, role, permissions) VALUES ($1, $2, $3, $4::jsonb)`,
          [PROBE, LOC_P, c.plRole, JSON.stringify(c.override)])
        if (c.tplAll) await db.query(`INSERT INTO public.location_role_permissions (location_id, role, employment_type, permissions) VALUES ($1, $2, 'all', $3::jsonb)`,
          [LOC_P, c.plRole, JSON.stringify(c.tplAll)])
        if (c.tplVar) await db.query(`INSERT INTO public.location_role_permissions (location_id, role, employment_type, permissions) VALUES ($1, $2, 'contractor', $3::jsonb)`,
          [LOC_P, c.plRole, JSON.stringify(c.tplVar)])
      }
      // JS: what getCurrentUser builds (loadRoleTemplatesForLocations merges
      // 'all' + the row for profiles.employment_type; masters skip templates).
      const tpl = c.plRole && !c.master ? mergeTemplates(c.tplAll, c.emp === 'contractor' ? c.tplVar : null) : null
      const user = {
        role: c.master ? 'master' : (c.plRole || 'staff'),
        assignmentsByLocation: c.plRole ? { [LOC_P]: { role: c.plRole, permissions: c.override } } : {},
        locations: (c.plRole || c.master) ? [{ id: LOC_P, role: c.plRole, features: c.features }] : [],
        roleTemplatesByLocation: tpl ? { [LOC_P]: tpl } : {},
      }
      const js = hasPermissionForLocation(user, LOC_P, 'contacts') || hasMobilePermissionForLocation(user, LOC_P, 'contacts')
      const [row] = await asUser(db, PROBE, `SELECT '${LOC_P}'::uuid = ANY (private.auth_contact_read_location_ids()) AS ok`)
      cases += 1
      answers[js] += 1
      if (row.ok !== js) mismatches.push({ ...c, js, sql: row.ok })
    }
  }, 600_000)
  afterAll(() => db?.close())

  it('covers the matrix (not vacuous)', () => {
    expect(cases).toBe(4 * (2 + 7 * 6 * 3 * 3 * 3))   // 4,544
  })

  it('both answers occur (the matrix is not one-sided)', () => {
    // a one-sided matrix would pass with a helper that always says yes or no
    expect(answers.true).toBeGreaterThan(500)
    expect(answers.false).toBeGreaterThan(500)
  })

  it('agrees on every combination', () => {
    expect(mismatches.slice(0, 5), `${mismatches.length} mismatches`).toEqual([])
  })
})

describe('the file aborts as a whole', () => {
  let db
  afterEach(async () => { await db?.close() })

  it('when contacts has a second policy (re-plan)', async () => {
    db = await bootProd({ before: `CREATE POLICY contacts_extra ON public.contacts FOR SELECT TO authenticated USING (false);` })
    expect(await abortMessage(db, MIG_690)).toMatch(/mig 690: public\.contacts did not start with exactly the 2 Oct contacts_select policy/)
    expect(await visible(db, IDS.STAFF_A)).toBe(5)
    const { rows: [r] } = await db.query(`SELECT to_regprocedure('private.auth_contact_read_location_ids()') AS fn`)
    expect(r.fn).toBeNull()
  }, 60_000)

  it('when contacts_select was changed by hand', async () => {
    db = await bootProd({ before: `ALTER POLICY contacts_select ON public.contacts USING (true);` })
    expect(await abortMessage(db, MIG_690)).toMatch(/mig 690: public\.contacts did not start with exactly the 2 Oct contacts_select policy/)
  }, 60_000)

  it('when the bundle seed has no contacts row (check:bundle-sql drift)', async () => {
    db = await bootProd({ before: `DELETE FROM private.permission_key_bundles WHERE key = 'contacts';` })
    expect(await abortMessage(db, MIG_690)).toMatch(/mig 690: private\.permission_key_bundles has no contacts row/)
  }, 60_000)

  it('when anon can read contacts again (657 undone)', async () => {
    db = await bootProd({ before: `GRANT SELECT ON public.contacts TO anon;` })
    expect(await abortMessage(db, MIG_690)).toMatch(/mig 690: anon holds SELECT on public\.contacts/)
  }, 60_000)

  it('when a column the helper reads is missing', async () => {
    db = await bootProd({ before: `ALTER TABLE public.profiles DROP COLUMN employment_type;` })
    expect(await abortMessage(db, MIG_690)).toMatch(/mig 690: a column the helper reads is missing/)
  }, 60_000)
})

describe("the plan's rollback record (POST-677 form)", () => {
  let db
  afterAll(() => db?.close())

  it('restores the membership policy and removes the helper; no privilege changes', async () => {
    db = await bootProd({ migrate: [MIG_690] })
    const { rows: [before] } = await db.query(`SELECT relacl::text AS acl FROM pg_class WHERE oid = 'public.contacts'::regclass`)
    await db['exec'](ROLLBACK_690)
    expect((await policiesOf(db, ['contacts']))[0].qual).toBe(OLD_QUAL)
    const { rows: [r] } = await db.query(`SELECT to_regprocedure('private.auth_contact_read_location_ids()') AS fn,
      relacl::text AS acl FROM pg_class WHERE oid = 'public.contacts'::regclass`)
    expect(r).toEqual({ fn: null, acl: before.acl })
    expect(await visible(db, IDS.STAFF_A)).toBe(5)
    // and 690 applies again on top of the rollback
    await signedOut(db)
    await db['exec'](MIG_690)
    expect(await visible(db, IDS.STAFF_A)).toBe(0)
  }, 60_000)
})
