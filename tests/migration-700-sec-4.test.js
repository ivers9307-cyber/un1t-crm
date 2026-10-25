// SEC-4 — behavioural test for migration 700 (follow-ups C144 + C143).
//
// Prod on 2 Oct 2026 (read-only, Supabase MCP): migs 690 and 691 APPLIED,
// 699 (SEC-3) open in the train. This replays that state through the C101
// harness: post-677 privileges, the 690/691 inputs, the pre-690/691 policies
// and bodies VERBATIM (as the 699 replay has them), then the REAL 690 and 691
// files and, when it is on disk, the REAL 699 (the state is run both ways).
// Added for 700: the uid-taking role functions (mig 626 bodies, verbatim),
// auth_is_manager_at, and shift_assignments with mig 614's helper and policy.
// The policy text and the bodies 700 depends on are asserted equal to prod's.
// Then the REAL 700 file, and:
//   * C144: a membership with phone Tasks and no Contacts reads 0 activities;
//     with both, it reads them; a studio whose Contacts switch is off is
//     unreadable (masters too); anon reads nothing; the write policies are
//     unchanged (a write that reads its row back is refused for Tasks-only);
//   * C143: authenticated can no longer execute get_user_role /
//     get_user_role_at (they answer about ANY user); service_role still can;
//     auth_can_read_shift_assignment keeps authenticated, and asking it about
//     another user's id answers only about the caller (fails closed);
//   * pins, InitPlan, idempotent, abort cases, the POST-677 rollback record
//     (the static guard that no later migration gives the two back is
//     tests/closed-function-regrant-guard.test.js).
// Fictional ids only: the repo is public.

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { boot, asUser, asRole, IDS, abortMessage, policiesOf } from './helpers/member-write-sweep.js'
import { KEY_BUNDLES } from '../shared/permission-bundles.js'

const MIGRATIONS = path.resolve(import.meta.dirname, '../supabase/migrations')
const mig = (f) => readFileSync(path.join(MIGRATIONS, f), 'utf8')
const MIG_690 = mig('690_contacts_read_needs_contacts_permission.sql')
const MIG_691 = mig('691_mobile_permissions_follow_role_templates.sql')
const F_699 = '699_org_admins_in_resolvers_uid_resolver_closed.sql'
const MIG_699 = existsSync(path.join(MIGRATIONS, F_699)) ? mig(F_699) : null
const F_700 = '700_activities_read_needs_contacts_uid_role_fns_closed.sql'
const MIG_700 = mig(F_700)

// prod, 2 Oct 2026 (pg_policies.qual / normalised md5 of prosrc)
const PROD = {
  activitiesSelect: `((location_id = ANY (( SELECT private.auth_mobile_can_location_ids('tasks'::text) AS auth_mobile_can_location_ids)::uuid[])) OR (location_id = ANY (( SELECT private.auth_mobile_can_location_ids('pipeline'::text) AS auth_mobile_can_location_ids)::uuid[])))`,
  activitiesDelete: 'private.auth_is_manager_at(location_id)',
  contact690: 'bb438f78e24a8630be135418e27fb253',
  getUserRole: '5d6b8c9bf57b916f1cbfd9ccc4194558',
  getUserRoleAt: '31c0a9aaab3d9424a3214971d8d746f8',
  shiftAssignment: '3780e385ebdce9936535c4f966c0f115',
  managerAt: '8185763547736edd5eb1826dd8aa813b',
}
const NEW_SELECT = `(${PROD.activitiesSelect} AND (location_id = ANY (( SELECT private.auth_contact_read_location_ids() AS auth_contact_read_location_ids)::uuid[])))`
const FN = {
  contact: 'private.auth_contact_read_location_ids()',
  role: 'private.get_user_role(uuid)',
  roleAt: 'private.get_user_role_at(uuid,uuid)',
  shift: 'private.auth_can_read_shift_assignment(uuid,uuid)',
}
const md5Sql = (fn) => `SELECT md5(regexp_replace(regexp_replace(prosrc, '--[^\\n]*', '', 'g'), '\\s+', '', 'g')) AS h FROM pg_proc WHERE oid = to_regprocedure('${fn}')`
const md5Of = async (db, fn) => (await db.query(md5Sql(fn))).rows[0]?.h
const aclOf = async (db, fn) => (await db.query(`SELECT coalesce(proacl::text, '-') AS a FROM pg_proc WHERE oid = to_regprocedure('${fn}')`)).rows[0]?.a
const canExec = async (db, fn) => (await db.query(`SELECT has_function_privilege('authenticated', to_regprocedure($1), 'EXECUTE') AS authenticated,
  has_function_privilege('service_role', to_regprocedure($1), 'EXECUTE') AS service_role,
  has_function_privilege('anon', to_regprocedure($1), 'EXECUTE') AS anon,
  has_function_privilege('public', to_regprocedure($1), 'EXECUTE') AS public`, [fn])).rows[0]
// prod proacl, 2 Oct 2026
const ACL = {
  open: '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}',
  service: '{postgres=X/postgres,service_role=X/postgres}',
  shift: '{postgres=X/postgres,authenticated=X/postgres}',
}

// The rollback record, cut from the file's own ROLLBACK comment block.
const ROLLBACK_700 = (() => {
  const block = MIG_700.slice(MIG_700.indexOf('-- ROLLBACK'))
  return block.split('\n').filter((l) => /^-- /.test(l) && !/ROLLBACK \(|^-- =+/.test(l)).map((l) => l.slice(3)).join('\n')
})()

const { LOC_A, LOC_B, STAFF_A, OWNER_A, STAFF_B, MASTER } = IDS
const ORG1 = 'f0000000-0000-0000-0000-000000000001'
const TASKS_ONLY = '10000000-0000-0000-0000-0000000000b1'     // staff at A: phone Tasks (default), Contacts off (web + phone)
const CONTACTS_ONLY = '10000000-0000-0000-0000-0000000000b2'  // staff at A: Contacts (default), phone Tasks off
const STRANGER = '10000000-0000-0000-0000-0000000000ff'       // no profile
const ROSTER_PUB = '50000000-0000-0000-0000-000000000001'
const ROSTER_DRAFT = '50000000-0000-0000-0000-000000000002'
const BLOCKS = {
  A_PUB: '60000000-0000-0000-0000-00000000000a',
  A_DRAFT: '60000000-0000-0000-0000-0000000000ad',
  B_PUB: '60000000-0000-0000-0000-00000000000b',
  B_DRAFT: '60000000-0000-0000-0000-0000000000bd',
}
const PHONE = ['activities', 'bookings', 'deals', 'notes', 'whatsapp_conversations', 'whatsapp_messages', 'whatsapp_templates']
const POLICY_KEYS = { activities: 'act', bookings: 'bookings', deals: 'pipeline', notes: 'pipeline' }
const WA_POLICY = { whatsapp_conversations: 'wa_conv_select', whatsapp_messages: 'wa_msg_select', whatsapp_templates: 'wa_tmpl_select' }

// Pre-691 bodies, verbatim from prod (migs 626 / 550; as in the 691 / 699 replays).
const MOBILE_CAN_FOR_626 = `
  SELECT loc_id IS NOT NULL
    AND coalesce((SELECT (features -> perm_key) <> 'false'::jsonb FROM public.locations WHERE id = loc_id), true)
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = p_uid
        AND p.active IS NOT FALSE
        AND p.deleted_at IS NULL
        AND (
          p.role = 'master'
          OR EXISTS (
            SELECT 1 FROM public.profile_locations pl
            WHERE pl.profile_id = p_uid AND pl.location_id = loc_id
              AND CASE
                WHEN pl.permissions -> 'mobile' ? perm_key
                  THEN (pl.permissions -> 'mobile' ->> perm_key) = 'true'
                ELSE coalesce((SELECT d.allowed FROM private.mobile_permission_defaults d
                               WHERE d.role = pl.role AND d.key = perm_key), false)
              END
          )
        )
    )
`
const AUTH_MOBILE_CAN_550 = `
  SELECT private.mobile_can_for((SELECT auth.uid()), loc_id, perm_key)
    AND (
      NOT EXISTS (
        SELECT 1 FROM private.permission_key_bundles pkb WHERE pkb.key = perm_key
      )
      OR
      EXISTS (
        SELECT 1 FROM private.permission_key_bundles pkb
        WHERE pkb.key = perm_key
          AND coalesce(
            (SELECT (features -> pkb.bundle) <> 'false'::jsonb FROM public.locations WHERE id = loc_id),
            true
          )
      )
    )
`
// Verbatim from prod (pg_proc.prosrc, 2 Oct 2026): migs 626 and 614.
const GET_USER_ROLE_626 = `
  SELECT CASE
    WHEN EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = user_id
        AND active IS NOT FALSE
        AND deleted_at IS NULL
    ) THEN
      CASE
        WHEN (SELECT role FROM public.profiles WHERE id = user_id) = 'master'
          THEN 'master'
        ELSE COALESCE(
          (
            SELECT role FROM public.profile_locations pl
            WHERE pl.profile_id = user_id
            ORDER BY CASE pl.role
              WHEN 'owner'      THEN 1
              WHEN 'manager'    THEN 2
              WHEN 'head_coach' THEN 3
              WHEN 'staff'      THEN 4
            END
            LIMIT 1
          ),
          (SELECT role FROM public.profiles WHERE id = user_id)
        )
      END
  END
`
const GET_USER_ROLE_AT_626 = `
  SELECT role
  FROM public.profile_locations
  WHERE profile_id = p_user_id
    AND location_id = p_location_id
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = p_user_id
        AND p.active IS NOT FALSE
        AND p.deleted_at IS NULL
    )
`
const AUTH_IS_MANAGER_AT_626 = `
  SELECT EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = (SELECT auth.uid())
      AND p.active IS NOT FALSE
      AND p.deleted_at IS NULL
      AND (
        p.role = 'master'
        OR EXISTS (
          SELECT 1 FROM public.profile_locations pl
          WHERE pl.profile_id = (SELECT auth.uid())
            AND pl.location_id = p_location_id
            AND pl.role IN ('owner','manager','head_coach')
        )
      )
  )
`
const SHIFT_ASSIGNMENT_614 = `
  SELECT EXISTS (
    SELECT 1
    FROM public.shift_blocks b
    WHERE b.id = p_block_id
      AND (
        private.auth_is_manager_at(b.location_id)
        OR (
          EXISTS (
            SELECT 1 FROM public.rosters r
            WHERE r.id = b.roster_id
              AND r.status = 'published'
          )
          AND (
            private.auth_is_in_location(b.location_id)
            OR p_profile_id = (SELECT auth.uid())
          )
        )
      )
  )
`
const BUNDLE_ROWS = Object.entries(KEY_BUNDLES).flatMap(([k, bs]) => bs.map((b) => `('${k}', '${b}')`)).join(', ')

const TABLES = `
  ALTER DEFAULT PRIVILEGES FOR ROLE postgres REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
  ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA private GRANT EXECUTE ON FUNCTIONS TO authenticated, service_role;
  REVOKE EXECUTE ON FUNCTION private.auth_is_master() FROM PUBLIC, anon;
  GRANT EXECUTE ON FUNCTION private.auth_is_master() TO authenticated, service_role;

  ALTER TABLE public.locations ADD COLUMN features jsonb NOT NULL DEFAULT '{}'::jsonb;
  ALTER TABLE public.locations ADD COLUMN active boolean DEFAULT true;
  ALTER TABLE public.locations ADD COLUMN organization_id uuid NOT NULL DEFAULT '${ORG1}';
  ALTER TABLE public.profiles ADD COLUMN employment_type text NOT NULL DEFAULT 'fte'
    CHECK (employment_type = ANY (ARRAY['fte', 'contractor']));
  ALTER TABLE public.profile_locations ADD COLUMN permissions jsonb NOT NULL DEFAULT '{}'::jsonb;
  CREATE TABLE public.location_role_permissions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), location_id uuid NOT NULL, role text NOT NULL,
    employment_type text NOT NULL DEFAULT 'all', permissions jsonb NOT NULL DEFAULT '{}'::jsonb,
    UNIQUE (location_id, role, employment_type));
  ALTER TABLE public.location_role_permissions ENABLE ROW LEVEL SECURITY;
  CREATE TABLE private.permission_key_bundles (key text NOT NULL, bundle text NOT NULL, PRIMARY KEY (key, bundle));
  CREATE TABLE private.mobile_permission_defaults (role text NOT NULL, key text NOT NULL, allowed boolean NOT NULL, PRIMARY KEY (role, key));
  CREATE TABLE public.profile_organizations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), profile_id uuid NOT NULL, organization_id uuid NOT NULL,
    role text NOT NULL DEFAULT 'org_admin' CHECK (role = 'org_admin'), created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (profile_id, organization_id));
  REVOKE ALL ON public.profile_organizations FROM anon, authenticated;
  GRANT SELECT, INSERT, UPDATE, DELETE ON public.profile_organizations TO authenticated;

  GRANT SELECT ON public.contacts TO authenticated;
  ${PHONE.map((t) => `CREATE TABLE public.${t} (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), location_id uuid);`).join('\n')}
  ${Object.keys(WA_POLICY).map((t) => `REVOKE INSERT, UPDATE, DELETE ON public.${t} FROM authenticated;`).join('\n')}
  CREATE FUNCTION private.mobile_can_for(p_uid uuid, loc_id uuid, perm_key text) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $fn$${MOBILE_CAN_FOR_626}$fn$;
  CREATE FUNCTION private.auth_mobile_can(loc_id uuid, perm_key text) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $fn$${AUTH_MOBILE_CAN_550}$fn$;

  -- C143's subjects, prod bodies and EXECUTE (2 Oct)
  CREATE FUNCTION private.get_user_role(user_id uuid) RETURNS text
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $fn$${GET_USER_ROLE_626}$fn$;
  CREATE FUNCTION private.get_user_role_at(p_user_id uuid, p_location_id uuid) RETURNS text
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $fn$${GET_USER_ROLE_AT_626}$fn$;
  CREATE FUNCTION private.auth_is_manager_at(p_location_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $fn$${AUTH_IS_MANAGER_AT_626}$fn$;
  CREATE TABLE public.rosters (id uuid PRIMARY KEY, status text NOT NULL);
  CREATE TABLE public.shift_blocks (id uuid PRIMARY KEY, location_id uuid NOT NULL, roster_id uuid);
  CREATE TABLE public.shift_assignments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), block_id uuid NOT NULL, profile_id uuid);
  REVOKE ALL ON public.rosters, public.shift_blocks FROM anon, authenticated;
  REVOKE ALL ON public.shift_assignments FROM anon, authenticated;
  GRANT SELECT ON public.shift_assignments TO authenticated;
  CREATE FUNCTION private.auth_can_read_shift_assignment(p_block_id uuid, p_profile_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $fn$${SHIFT_ASSIGNMENT_614}$fn$;
  REVOKE ALL ON FUNCTION private.auth_can_read_shift_assignment(uuid, uuid) FROM PUBLIC, anon, service_role;
  GRANT EXECUTE ON FUNCTION private.auth_can_read_shift_assignment(uuid, uuid) TO authenticated;
`

const POLICIES = `
  ALTER TABLE public.contacts ENABLE ROW LEVEL SECURITY;
  CREATE POLICY contacts_select ON public.contacts FOR SELECT TO public
    USING (private.auth_is_in_location(location_id) OR (user_id = (SELECT auth.uid())));
  ${Object.entries(POLICY_KEYS).map(([t, k]) => {
    const e = k === 'act' ? `(private.auth_mobile_can(location_id, 'tasks') OR private.auth_mobile_can(location_id, 'pipeline'))`
      : `private.auth_mobile_can(location_id, '${k}')`
    return `ALTER TABLE public.${t} ENABLE ROW LEVEL SECURITY;
      CREATE POLICY ${t}_select ON public.${t} FOR SELECT TO authenticated USING (${e});
      CREATE POLICY ${t}_insert ON public.${t} FOR INSERT TO authenticated WITH CHECK (${e});
      CREATE POLICY ${t}_update ON public.${t} FOR UPDATE TO authenticated USING (${e}) WITH CHECK (${e});`
  }).join('\n')}
  CREATE POLICY activities_delete ON public.activities FOR DELETE TO authenticated USING (private.auth_is_manager_at(location_id));
  ${Object.entries(WA_POLICY).map(([t, p]) => `ALTER TABLE public.${t} ENABLE ROW LEVEL SECURITY;
      CREATE POLICY ${p} ON public.${t} FOR SELECT TO authenticated USING (private.auth_mobile_can(location_id, 'whatsapp'));`).join('\n')}
  ALTER TABLE public.profile_organizations ENABLE ROW LEVEL SECURITY;
  CREATE POLICY profile_organizations_select ON public.profile_organizations FOR SELECT TO authenticated
    USING ((profile_id = (SELECT auth.uid())) OR private.auth_is_master());
  CREATE POLICY profile_organizations_ins ON public.profile_organizations FOR INSERT TO authenticated WITH CHECK (private.auth_is_master());
  CREATE POLICY profile_organizations_upd ON public.profile_organizations FOR UPDATE TO authenticated
    USING (private.auth_is_master()) WITH CHECK (private.auth_is_master());
  CREATE POLICY profile_organizations_del ON public.profile_organizations FOR DELETE TO authenticated USING (private.auth_is_master());
  ALTER TABLE public.shift_assignments ENABLE ROW LEVEL SECURITY;
  CREATE POLICY shift_assignments_select ON public.shift_assignments FOR SELECT TO authenticated
    USING (private.auth_can_read_shift_assignment(block_id, profile_id));
`

const SEED = `
  INSERT INTO private.permission_key_bundles VALUES ${BUNDLE_ROWS};
  INSERT INTO private.mobile_permission_defaults (role, key, allowed) VALUES
    ('staff','pipeline',false),('staff','tasks',true),('staff','bookings',false),('staff','whatsapp',false),
    ('head_coach','pipeline',true),('head_coach','tasks',true),('head_coach','bookings',true),('head_coach','whatsapp',true),
    ('manager','pipeline',true),('manager','tasks',true),('manager','bookings',true),('manager','whatsapp',true),
    ('owner','pipeline',true),('owner','tasks',true),('owner','bookings',true),('owner','whatsapp',true);
  INSERT INTO public.profiles (id, role) VALUES ('${TASKS_ONLY}', 'staff'), ('${CONTACTS_ONLY}', 'staff');
  INSERT INTO public.profile_locations (profile_id, location_id, role, permissions) VALUES
    ('${TASKS_ONLY}', '${LOC_A}', 'staff', '{"contacts": false, "mobile": {"contacts": false}}'),
    ('${CONTACTS_ONLY}', '${LOC_A}', 'staff', '{"mobile": {"tasks": false}}');
  -- one activity at A, one at B, one with no studio (2,655 such rows on prod)
  INSERT INTO public.activities (location_id) VALUES ('${LOC_A}'), ('${LOC_B}'), (NULL);
  INSERT INTO public.rosters VALUES ('${ROSTER_PUB}', 'published'), ('${ROSTER_DRAFT}', 'draft');
  INSERT INTO public.shift_blocks VALUES
    ('${BLOCKS.A_PUB}', '${LOC_A}', '${ROSTER_PUB}'), ('${BLOCKS.A_DRAFT}', '${LOC_A}', '${ROSTER_DRAFT}'),
    ('${BLOCKS.B_PUB}', '${LOC_B}', '${ROSTER_PUB}'), ('${BLOCKS.B_DRAFT}', '${LOC_B}', '${ROSTER_DRAFT}');
  -- STAFF_B (a member of B only) also works a shift at A
  INSERT INTO public.shift_assignments (block_id, profile_id) VALUES
    ('${BLOCKS.A_PUB}', '${STAFF_A}'), ('${BLOCKS.A_PUB}', '${STAFF_B}'), ('${BLOCKS.A_DRAFT}', '${STAFF_B}'), ('${BLOCKS.B_PUB}', '${STAFF_B}');
`

const signedOut = (db) => db.query(`SELECT set_config('request.jwt.claims', '{}', false)`)
// prod on 2 Oct: 690 + 691 applied; with699 adds SEC-3's file (when on disk)
const bootProd = async ({ with699 = false, before2 = '', migrate = [] } = {}) => {
  const db = await boot({ tables: TABLES, policies: POLICIES, seed: SEED, after677: true, migrate: [] })
  for (const sql of [MIG_690, MIG_691, ...(with699 ? [MIG_699] : [])]) { await signedOut(db); await db['exec'](sql) }
  if (before2) await db['exec'](before2)
  for (const sql of migrate) { await signedOut(db); await db['exec'](sql) }
  return db
}
const count = async (db, uid, t = 'activities') => (await asUser(db, uid, `SELECT count(*)::int AS n FROM public.${t}`))[0].n
const PEOPLE = { STAFF_A, OWNER_A, STAFF_B, MASTER, TASKS_ONLY, CONTACTS_ONLY }
const activityReads = async (db) => {
  const out = {}
  for (const [k, uid] of Object.entries(PEOPLE)) out[k] = await count(db, uid)
  return out
}
const selectQual = async (db) => (await policiesOf(db, ['activities'])).find((p) => p.policyname === 'activities_select')?.qual

const STATES = [{ label: '699 not applied (prod, 2 Oct)', with699: false }]
if (MIG_699) STATES.push({ label: '699 applied first', with699: true })

describe.each(STATES)('$label', ({ with699 }) => {
  describe('before 700', () => {
    let db
    beforeAll(async () => { db = await bootProd({ with699 }) }, 60_000)
    afterAll(() => db?.close())

    it('fixture fidelity: the 691 policy text and the bodies 700 depends on are prod\'s', async () => {
      expect(await selectQual(db)).toBe(PROD.activitiesSelect)
      expect((await policiesOf(db, ['activities'])).find((p) => p.policyname === 'activities_delete').qual).toBe(PROD.activitiesDelete)
      if (!with699) expect(await md5Of(db, FN.contact)).toBe(PROD.contact690)
      expect(await md5Of(db, FN.role)).toBe(PROD.getUserRole)
      expect(await md5Of(db, FN.roleAt)).toBe(PROD.getUserRoleAt)
      expect(await md5Of(db, FN.shift)).toBe(PROD.shiftAssignment)
      expect(await md5Of(db, 'private.auth_is_manager_at(uuid)')).toBe(PROD.managerAt)
      expect(await aclOf(db, FN.role)).toBe(ACL.open)
      expect(await aclOf(db, FN.roleAt)).toBe(ACL.open)
      expect(await aclOf(db, FN.shift)).toBe(ACL.shift)
      expect(await aclOf(db, FN.contact)).toBe(ACL.open)
    })

    it('the file pins 690\'s helper body and, when 699 is on disk, 699\'s', async () => {
      expect(MIG_700).toContain(`v_contact_690 text := '${PROD.contact690}'`)
      const pin699 = MIG_700.match(/v_contact_699 text := '([0-9a-f]{32})'/)[1]
      if (with699) expect(await md5Of(db, FN.contact)).toBe(pin699)
    })

    it('C144: phone Tasks without Contacts reads the studio\'s activities', async () => {
      expect(await activityReads(db)).toEqual({ STAFF_A: 1, OWNER_A: 1, STAFF_B: 1, MASTER: 2, TASKS_ONLY: 1, CONTACTS_ONLY: 0 })
    })

    it('C143: a signed-in session can ask another user\'s role', async () => {
      const [r] = await asUser(db, STAFF_A, `SELECT private.get_user_role('${OWNER_A}') AS g, private.get_user_role_at('${OWNER_A}', '${LOC_A}') AS a`)
      expect(r).toEqual({ g: 'owner', a: 'owner' })
    })
  })

  describe('after 700', () => {
    let db
    beforeAll(async () => { db = await bootProd({ with699, migrate: [MIG_700] }) }, 60_000)
    afterAll(() => db?.close())

    it('C144: Tasks without Contacts reads 0; Tasks with Contacts reads them; Contacts without Tasks still 0', async () => {
      expect(await activityReads(db)).toEqual({ STAFF_A: 1, OWNER_A: 1, STAFF_B: 1, MASTER: 2, TASKS_ONLY: 0, CONTACTS_ONLY: 0 })
    })

    it('C144: a studio whose Contacts switch is off is unreadable, masters included; back on, back again', async () => {
      await db.query(`UPDATE public.locations SET features = '{"contacts": false}'::jsonb WHERE id = $1`, [LOC_B])
      expect(await count(db, STAFF_B)).toBe(0)
      expect(await count(db, MASTER)).toBe(1)
      expect(await count(db, TASKS_ONLY)).toBe(0)
      await db.query(`UPDATE public.locations SET features = '{}'::jsonb WHERE id = $1`, [LOC_B])
      expect(await count(db, STAFF_B)).toBe(1)
      expect(await count(db, MASTER)).toBe(2)
    })

    it('C144: Contacts back on for the Tasks-only membership brings the rows back (per-user override)', async () => {
      await db.query(`UPDATE public.profile_locations SET permissions = '{"mobile": {"contacts": true}}' WHERE profile_id = $1`, [TASKS_ONLY])
      expect(await count(db, TASKS_ONLY)).toBe(1)
      await db.query(`UPDATE public.profile_locations SET permissions = '{"contacts": false, "mobile": {"contacts": false}}' WHERE profile_id = $1`, [TASKS_ONLY])
      expect(await count(db, TASKS_ONLY)).toBe(0)
    })

    it('anon reads nothing; a signed-out authenticated session reads nothing', async () => {
      await expect(asRole(db, 'anon', 'SELECT count(*) FROM public.activities')).rejects.toThrow(/permission denied for table activities/)
      expect((await asRole(db, 'authenticated', 'SELECT count(*)::int AS n FROM public.activities'))[0].n).toBe(0)
    })

    it('the write policies are unchanged; a Tasks-only write that reads its row back is refused whole', async () => {
      await expect(asUser(db, TASKS_ONLY, `INSERT INTO public.activities (location_id) VALUES ('${LOC_A}')`)).resolves.toBeDefined()
      await expect(asUser(db, TASKS_ONLY, `INSERT INTO public.activities (location_id) VALUES ('${LOC_A}') RETURNING id`))
        .rejects.toThrow(/row-level security/)
      await expect(asUser(db, STAFF_A, `INSERT INTO public.activities (location_id) VALUES ('${LOC_A}') RETURNING id`)).resolves.toHaveLength(1)
      await expect(asUser(db, STAFF_A, `INSERT INTO public.activities (location_id) VALUES ('${LOC_B}')`)).rejects.toThrow(/row-level security/)
      const ps = Object.fromEntries((await policiesOf(db, ['activities'])).map((p) => [p.policyname, p]))
      expect(Object.keys(ps).sort()).toEqual(['activities_delete', 'activities_insert', 'activities_select', 'activities_update'])
      expect(ps.activities_insert.with_check).toBe(PROD.activitiesSelect)
      expect(ps.activities_update.qual).toBe(PROD.activitiesSelect)
      expect(ps.activities_update.with_check).toBe(PROD.activitiesSelect)
      expect(ps.activities_delete.qual).toBe(PROD.activitiesDelete)
    })

    it('the new USING is the text the file pins; the helpers stay InitPlans', async () => {
      expect(await selectQual(db)).toBe(NEW_SELECT)
      const pins = [...MIG_700.matchAll(/v_new text := \$q\$([\s\S]*?)\$q\$/g)].map((m) => m[1])
      expect(pins).toHaveLength(2)
      for (const p of pins) expect(p).toBe(NEW_SELECT)
      expect(MIG_700).toContain(`v_old text := $q$${PROD.activitiesSelect}$q$`)
      const rows = await asUser(db, OWNER_A, 'EXPLAIN SELECT count(*) FROM public.activities')
      const plan = rows.map((r) => r['QUERY PLAN']).join('\n')
      expect((plan.match(/InitPlan/g) || []).length).toBeGreaterThanOrEqual(3)
      expect(plan).not.toMatch(/SubPlan/)
    })

    it('C143: authenticated cannot execute get_user_role / get_user_role_at; service_role can', async () => {
      await expect(asUser(db, STAFF_A, `SELECT private.get_user_role('${OWNER_A}')`)).rejects.toThrow(/permission denied for function get_user_role/)
      await expect(asUser(db, STAFF_A, `SELECT private.get_user_role_at('${OWNER_A}', '${LOC_A}')`)).rejects.toThrow(/permission denied for function get_user_role_at/)
      const [s] = await asRole(db, 'service_role', `SELECT private.get_user_role('${OWNER_A}') AS g, private.get_user_role_at('${OWNER_A}', '${LOC_A}') AS a`)
      expect(s).toEqual({ g: 'owner', a: 'owner' })
      expect(await canExec(db, FN.role)).toEqual({ authenticated: false, service_role: true, anon: false, public: false })
      expect(await canExec(db, FN.roleAt)).toEqual({ authenticated: false, service_role: true, anon: false, public: false })
      expect(await aclOf(db, FN.role)).toBe(ACL.service)
      expect(await aclOf(db, FN.roleAt)).toBe(ACL.service)
      // bodies untouched
      expect(await md5Of(db, FN.role)).toBe(PROD.getUserRole)
      expect(await md5Of(db, FN.roleAt)).toBe(PROD.getUserRoleAt)
    })

    it('C143: auth_can_read_shift_assignment keeps authenticated; its policy still answers', async () => {
      expect(await aclOf(db, FN.shift)).toBe(ACL.shift)
      expect(await aclOf(db, FN.contact)).toBe(ACL.open)
      // STAFF_A (member of A): both assignments on A's published block. STAFF_B (member of B):
      // their own on A's published block and the one on B's published block, never A's draft.
      expect(await count(db, STAFF_A, 'shift_assignments')).toBe(2)
      expect(await count(db, STAFF_B, 'shift_assignments')).toBe(2)
      expect(await count(db, OWNER_A, 'shift_assignments')).toBe(3)
    })

    it('C143: auth_can_read_shift_assignment asked about ANOTHER user answers only about the caller (fails closed)', async () => {
      // For every caller, block and uid that is not the caller's, the answer equals the answer for a
      // uid that belongs to nobody: the uid only ever matters when it IS the caller.
      const callers = [...Object.values(PEOPLE), STRANGER]
      let compared = 0
      for (const caller of callers) {
        for (const block of Object.values(BLOCKS)) {
          const [base] = await asUser(db, caller, `SELECT private.auth_can_read_shift_assignment('${block}', '00000000-0000-0000-0000-000000000000') AS ok`)
          for (const other of callers.filter((u) => u !== caller)) {
            const [r] = await asUser(db, caller, `SELECT private.auth_can_read_shift_assignment('${block}', '${other}') AS ok`)
            expect(r.ok, `${caller} asking about ${other} on ${block}`).toBe(base.ok)
            compared++
          }
        }
      }
      expect(compared).toBe(7 * 4 * 6)
      // and the self branch is real: STAFF_B is no member of A, yet reads their own A shift
      const [self] = await asUser(db, STAFF_B, `SELECT private.auth_can_read_shift_assignment('${BLOCKS.A_PUB}', '${STAFF_B}') AS ok`)
      expect(self.ok).toBe(true)
    })

    it('a second run passes and changes nothing', async () => {
      await signedOut(db)
      await expect(db['exec'](MIG_700)).resolves.toBeDefined()
      expect(await selectQual(db)).toBe(NEW_SELECT)
      expect(await activityReads(db)).toEqual({ STAFF_A: 1, OWNER_A: 1, STAFF_B: 1, MASTER: 2, TASKS_ONLY: 0, CONTACTS_ONLY: 0 })
      expect(await aclOf(db, FN.role)).toBe(ACL.service)
    })
  })

  describe('the file aborts as a whole', () => {
    let db
    afterEach(async () => { await db?.close() })

    it('when activities_select is not the 691 policy', async () => {
      db = await bootProd({ with699, before2: `ALTER POLICY activities_select ON public.activities USING (private.auth_is_in_location(location_id));` })
      expect(await abortMessage(db, MIG_700)).toMatch(/mig 700: activities_select is not the mig 691 policy/)
      expect(await aclOf(db, FN.role)).toBe(ACL.open)
    }, 60_000)

    it('when another policy lets a client read activities (the AND would not bind)', async () => {
      db = await bootProd({ with699, before2: `CREATE POLICY activities_extra ON public.activities FOR SELECT TO authenticated USING (private.auth_is_in_location(location_id));` })
      expect(await abortMessage(db, MIG_700)).toMatch(/mig 700: activities has another SELECT\/ALL or restrictive policy/)
    }, 60_000)

    it('when the Contacts helper is neither the 690 nor the 699 body', async () => {
      db = await bootProd({ with699, before2: `CREATE OR REPLACE FUNCTION private.auth_contact_read_location_ids() RETURNS uuid[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $function$ SELECT '{}'::uuid[] $function$;` })
      expect(await abortMessage(db, MIG_700)).toMatch(/mig 700: private\.auth_contact_read_location_ids is not the mig 690 \/ 699 body/)
      expect(await selectQual(db)).toBe(PROD.activitiesSelect)
    }, 60_000)

    it('when a role function is not the 626 body', async () => {
      db = await bootProd({ with699, before2: `CREATE OR REPLACE FUNCTION private.get_user_role_at(p_user_id uuid, p_location_id uuid) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $function$ SELECT NULL::text $function$;` })
      expect(await abortMessage(db, MIG_700)).toMatch(/mig 700: not the mig 626 body \(or missing\): private\.get_user_role_at/)
    }, 60_000)

    it('when a policy or a function calls get_user_role (revoking authenticated would 42501 it)', async () => {
      db = await bootProd({ with699, before2: `CREATE POLICY deals_extra ON public.deals FOR SELECT TO authenticated USING (private.get_user_role((SELECT auth.uid())) = 'owner');` })
      expect(await abortMessage(db, MIG_700)).toMatch(/mig 700: something calls private\.get_user_role/)
      await db.close()
      db = await bootProd({ with699, before2: `CREATE FUNCTION public.my_role_at(l uuid) RETURNS text LANGUAGE sql STABLE AS $f$ SELECT private.get_user_role_at((SELECT auth.uid()), l) $f$;` })
      expect(await abortMessage(db, MIG_700)).toMatch(/mig 700: something calls private\.get_user_role.*my_role_at\(uuid\)/)
    }, 60_000)
  })

  describe("the file's rollback record (POST-677)", () => {
    let db
    afterAll(() => db?.close())

    it('restores the 691 USING verbatim and authenticated\'s EXECUTE; 700 applies again after it', async () => {
      expect(ROLLBACK_700).toMatch(/^BEGIN;[\s\S]*ALTER POLICY activities_select[\s\S]*GRANT EXECUTE[\s\S]*COMMIT;$/)
      db = await bootProd({ with699, migrate: [MIG_700] })
      await db['exec'](ROLLBACK_700)
      expect(await selectQual(db)).toBe(PROD.activitiesSelect)
      expect(await count(db, TASKS_ONLY)).toBe(1)
      // a re-GRANT appends authenticated after service_role, so compare privileges, not the ACL text
      expect(await canExec(db, FN.role)).toEqual({ authenticated: true, service_role: true, anon: false, public: false })
      expect(await canExec(db, FN.roleAt)).toEqual({ authenticated: true, service_role: true, anon: false, public: false })
      await signedOut(db)
      await db['exec'](MIG_700)
      expect(await count(db, TASKS_ONLY)).toBe(0)
      expect(await canExec(db, FN.role)).toEqual({ authenticated: false, service_role: true, anon: false, public: false })
    }, 60_000)
  })
})

// The static guard that no later migration gives authenticated / anon /
// PUBLIC back EXECUTE on the two closed here (or 699's mobile_can_for), by a
// GRANT or by a DROP + CREATE that takes the default ACL, is
// tests/closed-function-regrant-guard.test.js (C147); the registry of closed
// functions is tests/helpers/closed-functions.js.
