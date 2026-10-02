// SEC-3 — behavioural test for migration 699 (follow-ups C135 + C137; C132
// is proven closed by 691 and guarded in tests/activities-read-scope-guard).
//
// Prod on 2 Oct 2026 (read-only, Supabase MCP): migs 690 and 691 APPLIED.
// This replays that state through the C101 harness: post-677 privileges, the
// 690/691 inputs (locations.features/active/organization_id, profiles
// .employment_type, profile_locations.permissions, location_role_permissions,
// private.permission_key_bundles from KEY_BUNDLES, the 16-row
// private.mobile_permission_defaults), profile_organizations as prod has it
// (role CHECK 'org_admin', UNIQUE, master-only write policies), the
// pre-690/691 policies and function bodies VERBATIM, then the REAL 690 and
// 691 files. The two bodies 699 replaces are asserted to hash exactly as
// prod's do. Then the REAL 699 file, and:
//   * C137: an organisation admin is owner at every ACTIVE studio of their
//     organisation where they hold no membership (contacts + the 7 phone
//     tables), as getCurrentUser's SAAS-4 tier says; explicit memberships
//     keep their role; the owner role templates bind them; inactive studios,
//     other organisations, deactivated / tombstoned admins: nothing;
//   * C135: authenticated can no longer execute the uid-taking
//     private.mobile_can_for (it could ask about ANOTHER user); service_role
//     still can; the caller-only auth_mobile_can is unchanged;
//   * THE PARITY MATRIX: 27 profiles x 288 studios x 5 keys (37,920 cases;
//     the master at active studios only), SQL === the real JS (expandOrgAdminAccess + loadRoleTemplatesForLocations
//     + hasPermissionForLocation / hasMobilePermissionForLocation);
//   * ACLs, md5 pins, the 16 policies untouched, InitPlan, idempotent, abort
//     cases, the POST-677 rollback record.
// Fictional ids only: the repo is public.

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { boot, asUser, asRole, IDS, abortMessage, policiesOf } from './helpers/member-write-sweep.js'
import { hasPermissionForLocation, hasMobilePermissionForLocation } from '../src/lib/permissions.js'
import { expandOrgAdminAccess, buildRolesByLocation } from '../src/lib/auth.js'
import { loadRoleTemplatesForLocations } from '../src/lib/role-templates.js'
import { KEY_BUNDLES } from '../shared/permission-bundles.js'

const mig = (f) => readFileSync(path.resolve(import.meta.dirname, '../supabase/migrations', f), 'utf8')
const MIG_690 = mig('690_contacts_read_needs_contacts_permission.sql')
const MIG_691 = mig('691_mobile_permissions_follow_role_templates.sql')
const MIG_699 = mig('699_org_admins_in_resolvers_uid_resolver_closed.sql')

// Normalised md5 (comments and whitespace removed), the form 691 pins, of
// prod's bodies on 2 Oct 2026 (after 690 and 691 applied).
const PROD_MD5 = {
  contact: 'bb438f78e24a8630be135418e27fb253',   // private.auth_contact_read_location_ids()
  core: 'fd91cdf4aca619f24342ac41939bd03c',      // private.mobile_can_location_ids_for(uuid,text)
  mobileCanFor: 'b92e8c25d44105006c7efd8900f23cc2', // private.mobile_can_for (691 delegation; 699 leaves it)
}
const FN = {
  contact: 'private.auth_contact_read_location_ids()',
  core: 'private.mobile_can_location_ids_for(uuid,text)',
  mobileCanFor: 'private.mobile_can_for(uuid,uuid,text)',
  authMobileCan: 'private.auth_mobile_can(uuid,text)',
  wrapper: 'private.auth_mobile_can_location_ids(text)',
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
}

// The rollback record (POST-677): the 690 and 691 definitions verbatim, cut
// from the real files, and authenticated's EXECUTE back on mobile_can_for.
const defOf = (sql, name) => {
  const at = sql.search(new RegExp(`CREATE OR REPLACE FUNCTION private\\.${name}\\(`))
  const end = sql.indexOf('$function$;', sql.indexOf('$function$', at) + 10)
  return sql.slice(at, end + '$function$;'.length)
}
const ROLLBACK_699 = `
BEGIN;
SET LOCAL lock_timeout = '5s';
${defOf(MIG_690, 'auth_contact_read_location_ids')}
${defOf(MIG_691, 'mobile_can_location_ids_for')}
GRANT EXECUTE ON FUNCTION private.mobile_can_for(uuid, uuid, text) TO authenticated;
COMMIT;
`

const { LOC_A, LOC_B } = IDS
const LOC_C = 'c0000000-0000-0000-0000-00000000000c'   // ORG1, inactive
const LOC_D = 'd0000000-0000-0000-0000-00000000000d'   // ORG2
const ORG1 = 'f0000000-0000-0000-0000-000000000001'
const ORG2 = 'f0000000-0000-0000-0000-000000000002'
const ORG_ADMIN = '10000000-0000-0000-0000-0000000000a1'        // org admin of ORG1, no membership
const ORG_ADMIN_STAFF = '10000000-0000-0000-0000-0000000000a2'  // org admin of ORG1, explicit staff at B
const PHONE = ['activities', 'bookings', 'deals', 'notes', 'whatsapp_conversations', 'whatsapp_messages', 'whatsapp_templates']
const POLICY_KEYS = { activities: 'act', bookings: 'bookings', deals: 'pipeline', notes: 'pipeline' }
const WA_POLICY = { whatsapp_conversations: 'wa_conv_select', whatsapp_messages: 'wa_msg_select', whatsapp_templates: 'wa_tmpl_select' }

// Pre-691 bodies, verbatim from prod (migs 626 / 550; as in the 691 replay).
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

  -- profile_organizations as prod has it (mig 417 + 622): authenticated arwd,
  -- master-only writes, own-row-or-master reads.
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
  ${Object.entries(WA_POLICY).map(([t, p]) => `ALTER TABLE public.${t} ENABLE ROW LEVEL SECURITY;
      CREATE POLICY ${p} ON public.${t} FOR SELECT TO authenticated USING (private.auth_mobile_can(location_id, 'whatsapp'));`).join('\n')}
  ALTER TABLE public.profile_organizations ENABLE ROW LEVEL SECURITY;
  CREATE POLICY profile_organizations_select ON public.profile_organizations FOR SELECT TO authenticated
    USING ((profile_id = (SELECT auth.uid())) OR private.auth_is_master());
  CREATE POLICY profile_organizations_ins ON public.profile_organizations FOR INSERT TO authenticated WITH CHECK (private.auth_is_master());
  CREATE POLICY profile_organizations_upd ON public.profile_organizations FOR UPDATE TO authenticated
    USING (private.auth_is_master()) WITH CHECK (private.auth_is_master());
  CREATE POLICY profile_organizations_del ON public.profile_organizations FOR DELETE TO authenticated USING (private.auth_is_master());
`

const SEED = `
  INSERT INTO private.permission_key_bundles VALUES ${BUNDLE_ROWS};
  INSERT INTO private.mobile_permission_defaults (role, key, allowed) VALUES
    ('staff','pipeline',false),('staff','tasks',true),('staff','bookings',false),('staff','whatsapp',false),
    ('head_coach','pipeline',true),('head_coach','tasks',true),('head_coach','bookings',true),('head_coach','whatsapp',true),
    ('manager','pipeline',true),('manager','tasks',true),('manager','bookings',true),('manager','whatsapp',true),
    ('owner','pipeline',true),('owner','tasks',true),('owner','bookings',true),('owner','whatsapp',true);
  INSERT INTO public.locations (id, active, organization_id) VALUES ('${LOC_C}', false, '${ORG1}'), ('${LOC_D}', true, '${ORG2}');
  INSERT INTO public.profiles (id, role) VALUES ('${ORG_ADMIN}', 'staff'), ('${ORG_ADMIN_STAFF}', 'owner');
  INSERT INTO public.profile_locations (profile_id, location_id, role) VALUES ('${ORG_ADMIN_STAFF}', '${LOC_B}', 'staff');
  INSERT INTO public.profile_organizations (profile_id, organization_id) VALUES ('${ORG_ADMIN}', '${ORG1}'), ('${ORG_ADMIN_STAFF}', '${ORG1}');
  -- the owner 'all' template at B switches Contacts (web + phone) and phone WhatsApp off
  INSERT INTO public.location_role_permissions (location_id, role, employment_type, permissions)
    VALUES ('${LOC_B}', 'owner', 'all', '{"contacts": false, "mobile": {"contacts": false, "whatsapp": false}}');
  INSERT INTO public.contacts (id, location_id, user_id) VALUES
    ('30000000-0000-0000-0000-0000000000c1', '${LOC_C}', NULL), ('30000000-0000-0000-0000-0000000000d1', '${LOC_D}', NULL);
  ${PHONE.map((t) => `INSERT INTO public.${t} (location_id) VALUES ('${LOC_A}'), ('${LOC_B}'), ('${LOC_C}'), ('${LOC_D}');`).join('\n')}
`

const signedOut = (db) => db.query(`SELECT set_config('request.jwt.claims', '{}', false)`)
// prod on 2 Oct: 690 and 691 applied
const bootProd = async (opts = {}) => {
  const db = await boot({ tables: TABLES, policies: POLICIES, seed: SEED, after677: true, ...opts, migrate: [] })
  await signedOut(db)
  await db['exec'](MIG_690)
  await signedOut(db)
  await db['exec'](MIG_691)
  if (opts.before2) await db['exec'](opts.before2)
  for (const sql of opts.migrate || []) { await signedOut(db); await db['exec'](sql) }
  return db
}
const count = async (db, uid, t) => (await asUser(db, uid, `SELECT count(*)::int AS n FROM public.${t}`))[0].n
const reads = async (db, uid) => {
  const out = { contacts: await count(db, uid, 'contacts') }
  for (const t of PHONE) out[t] = await count(db, uid, t)
  return out
}
const shape = (contacts, phone) => ({ contacts, ...Object.fromEntries(PHONE.map((t) => [t, typeof phone === 'function' ? phone(t) : phone])) })
const WA = Object.keys(WA_POLICY)

describe('before 699: prod on 2 Oct 2026 (690 + 691 applied)', () => {
  let db
  beforeAll(async () => { db = await bootProd() }, 60_000)
  afterAll(() => db?.close())

  it('the replayed bodies hash exactly as prod\'s (fixture fidelity)', async () => {
    expect(await md5Of(db, FN.contact)).toBe(PROD_MD5.contact)
    expect(await md5Of(db, FN.core)).toBe(PROD_MD5.core)
    expect(await md5Of(db, FN.mobileCanFor)).toBe(PROD_MD5.mobileCanFor)
  })

  it('the ACLs are prod\'s', async () => {
    expect(await aclOf(db, FN.contact)).toBe(ACL.open)
    expect(await aclOf(db, FN.core)).toBe(ACL.service)
    expect(await aclOf(db, FN.mobileCanFor)).toBe(ACL.open)
    expect(await aclOf(db, FN.authMobileCan)).toBe(ACL.open)
  })

  it('C137: an org admin with no membership reads nothing; with one, only that membership', async () => {
    expect(await reads(db, ORG_ADMIN)).toEqual(shape(0, 0))
    expect(await reads(db, ORG_ADMIN_STAFF)).toEqual(shape(1, (t) => (t === 'activities' ? 1 : 0)))
  })

  it('C135: a signed-in user can ask mobile_can_for about ANOTHER user', async () => {
    const [r] = await asUser(db, IDS.STAFF_A, `SELECT private.mobile_can_for('${IDS.OWNER_A}', '${LOC_A}', 'pipeline') AS ok`)
    expect(r.ok).toBe(true)
  })
})

describe('after 699', () => {
  let db
  beforeAll(async () => { db = await bootProd({ migrate: [MIG_699] }) }, 60_000)
  afterAll(() => db?.close())

  it('C137: an org admin is owner at the active studios of their org (contacts + phone tables), templates included', async () => {
    // A: owner defaults (3 contacts, every phone table). B: the owner template
    // switches Contacts and phone WhatsApp off. C: inactive. D: another org.
    expect(await reads(db, ORG_ADMIN)).toEqual(shape(3, (t) => (WA.includes(t) ? 1 : 2)))
  })

  it('C137: an explicit membership keeps its role (staff at B), the org tier fills the rest (owner at A)', async () => {
    // A as owner: 3 contacts, every phone table; B as staff: 1 contact, Tasks only.
    expect(await reads(db, ORG_ADMIN_STAFF)).toEqual(shape(4, (t) => (t === 'activities' ? 2 : 1)))
  })

  it('C137: the employment-type template binds the org admin too', async () => {
    await db.query(`UPDATE public.profiles SET employment_type = 'contractor' WHERE id = $1`, [ORG_ADMIN])
    await db.query(`INSERT INTO public.location_role_permissions (location_id, role, employment_type, permissions)
      VALUES ($1, 'owner', 'contractor', '{"mobile": {"bookings": false}}')`, [LOC_A])
    expect(await count(db, ORG_ADMIN, 'bookings')).toBe(1)   // B only
    await db.query(`DELETE FROM public.location_role_permissions WHERE employment_type = 'contractor'`)
    await db.query(`UPDATE public.profiles SET employment_type = 'fte' WHERE id = $1`, [ORG_ADMIN])
    expect(await count(db, ORG_ADMIN, 'bookings')).toBe(2)
  })

  it('C137: a studio switched active again comes back; the studio switch and bundle bind the org admin', async () => {
    await db.query(`UPDATE public.locations SET active = NULL WHERE id = $1`, [LOC_C])
    expect(await count(db, ORG_ADMIN, 'activities')).toBe(2)   // NULL is not active (JS: .eq('active', true))
    await db.query(`UPDATE public.locations SET active = true WHERE id = $1`, [LOC_C])
    expect(await count(db, ORG_ADMIN, 'activities')).toBe(3)
    expect(await count(db, ORG_ADMIN, 'contacts')).toBe(4)
    await db.query(`UPDATE public.locations SET features = '{"bundle_sales": false}'::jsonb WHERE id = $1`, [LOC_C])
    expect(await count(db, ORG_ADMIN, 'activities')).toBe(2)
    expect(await count(db, ORG_ADMIN, 'contacts')).toBe(3)
    await db.query(`UPDATE public.locations SET active = false, features = '{}'::jsonb WHERE id = $1`, [LOC_C])
  })

  it('C137: a deactivated or tombstoned org admin reads nothing', async () => {
    await db.query(`UPDATE public.profiles SET active = false WHERE id = $1`, [ORG_ADMIN])
    expect(await reads(db, ORG_ADMIN)).toEqual(shape(0, 0))
    await db.query(`UPDATE public.profiles SET active = true, deleted_at = now() WHERE id = $1`, [ORG_ADMIN])
    expect(await reads(db, ORG_ADMIN)).toEqual(shape(0, 0))
    await db.query(`UPDATE public.profiles SET deleted_at = NULL WHERE id = $1`, [ORG_ADMIN])
    expect(await reads(db, ORG_ADMIN)).toEqual(shape(3, (t) => (WA.includes(t) ? 1 : 2)))
  })

  it('everyone without an org-admin row reads exactly what they did', async () => {
    expect(await reads(db, IDS.OWNER_A)).toEqual(shape(3, 1))
    expect(await reads(db, IDS.STAFF_A)).toEqual(shape(3, (t) => (t === 'activities' ? 1 : 0)))
    expect(await reads(db, IDS.STAFF_B)).toEqual(shape(1, (t) => (t === 'activities' ? 1 : 0)))
    expect(await reads(db, IDS.MASTER)).toEqual(shape(6, 4))
    expect(await reads(db, IDS.MEMBER_UID)).toEqual(shape(1, 0))
  })

  it('writes follow reads for the org admin (WITH CHECK)', async () => {
    await expect(asUser(db, ORG_ADMIN, `INSERT INTO public.deals (location_id) VALUES ('${LOC_A}')`)).resolves.toBeDefined()
    await expect(asUser(db, ORG_ADMIN, `INSERT INTO public.deals (location_id) VALUES ('${LOC_D}')`)).rejects.toThrow(/row-level security/)
    await expect(asUser(db, ORG_ADMIN, `INSERT INTO public.deals (location_id) VALUES ('${LOC_C}')`)).rejects.toThrow(/row-level security/)
  })

  it('C135: authenticated cannot execute mobile_can_for; service_role can; the caller-only entry points still answer', async () => {
    await expect(asUser(db, IDS.STAFF_A, `SELECT private.mobile_can_for('${IDS.OWNER_A}', '${LOC_A}', 'pipeline')`))
      .rejects.toThrow(/permission denied for function mobile_can_for/)
    const [s] = await asRole(db, 'service_role', `SELECT private.mobile_can_for('${IDS.OWNER_A}', '${LOC_A}', 'pipeline') AS ok`)
    expect(s.ok).toBe(true)
    const [a] = await asUser(db, ORG_ADMIN, `SELECT private.auth_mobile_can('${LOC_A}', 'pipeline') AS a, private.auth_mobile_can('${LOC_D}', 'pipeline') AS d,
      '${LOC_A}'::uuid = ANY (private.auth_mobile_can_location_ids('pipeline')) AS w`)
    expect(a).toEqual({ a: true, d: false, w: true })
  })

  it('ACLs: mobile_can_for = postgres + service_role; the two replaced functions keep theirs', async () => {
    expect(await aclOf(db, FN.mobileCanFor)).toBe(ACL.service)
    expect(await aclOf(db, FN.contact)).toBe(ACL.open)
    expect(await aclOf(db, FN.core)).toBe(ACL.service)
    expect(await aclOf(db, FN.authMobileCan)).toBe(ACL.open)
    expect(await aclOf(db, FN.wrapper)).toBe(ACL.open)
  })

  it('the new bodies hash as 699 pins them; mobile_can_for\'s body is untouched', async () => {
    // pinned twice each (pre-check re-run branch and self-check); both copies must agree
    const all = [...MIG_699.matchAll(/v_new_(contact|core)\s+text\s*:=\s*'([0-9a-f]{32})'/g)].map((m) => [m[1], m[2]])
    expect(all).toHaveLength(4)
    const pins = [...new Map(all)]
    expect(new Set(all.map((p) => p.join())).size).toBe(2)
    for (const [k, h] of pins) expect(await md5Of(db, FN[k]), k).toBe(h)
    expect(await md5Of(db, FN.mobileCanFor)).toBe(PROD_MD5.mobileCanFor)
  })

  it('the 16 policies 690/691 wrote are untouched; the helpers stay InitPlans', async () => {
    const ps = await policiesOf(db, ['contacts', ...PHONE])
    expect(ps).toHaveLength(16)
    expect(ps.find((p) => p.tablename === 'contacts').qual).toMatch(/auth_contact_read_location_ids\(\) AS auth_contact_read_location_ids\)::uuid\[\]/)
    for (const t of ['contacts', 'activities']) {
      const rows = await asUser(db, ORG_ADMIN, `EXPLAIN SELECT count(*) FROM public.${t}`)
      const plan = rows.map((r) => r['QUERY PLAN']).join('\n')
      expect(plan, t).toMatch(/InitPlan/)
      expect(plan, t).not.toMatch(/SubPlan/)
    }
  })

  it('a second run passes and changes nothing', async () => {
    await signedOut(db)
    await expect(db['exec'](MIG_699)).resolves.toBeDefined()
    expect(await reads(db, ORG_ADMIN_STAFF)).toEqual(shape(4, (t) => (t === 'activities' ? 2 : 1)))
    expect(await aclOf(db, FN.mobileCanFor)).toBe(ACL.service)
  })
})

describe('THE PARITY MATRIX: SQL === the real JS org-admin tier (27 profiles x 288 studios x 5 keys, 37,920 cases)', () => {
  const runs = {}
  const PHONE_KEYS = ['pipeline', 'tasks', 'bookings', 'whatsapp']
  const all4 = (v) => Object.fromEntries(PHONE_KEYS.map((k) => [k, v]))
  const ROLES_WITH_TEMPLATES = ['owner', 'staff', 'reception']
  const uuid = (prefix, n) => `${prefix}${String(n).padStart(12, '0')}`

  // The same matrix before and after 699: before, the ONLY disagreements are
  // the org tier (proves the matrix sees it); after, none.
  const runMatrix = async (migrate) => {
    const db = await bootProd({ migrate })
    const mismatches = []
    let cases = 0
    const answers = { true: 0, false: 0 }
    let orgTier = 0
    const FEATURES = [
      {},
      { contacts: false, ...all4(false) },
      { bundle_sales: false, bundle_members: false, bundle_messaging: false, bundle_marketing: false },
      { bundle_messaging: false },
    ]
    const TPL_ALL = [null, { contacts: false, mobile: { contacts: false, ...all4(false) } }, { mobile: { contacts: true, ...all4(true) } }, { mobile: { tasks: false } }]
    const TPL_VAR = [null, { contacts: true, mobile: { ...all4(true) } }, { mobile: { whatsapp: false, contacts: false } }]
    const locs = []
    let n = 0
    for (const org of [ORG1, ORG2]) for (const active of [true, false, null]) for (const features of FEATURES)
      for (const tplAll of TPL_ALL) for (const tplVar of TPL_VAR) {
        locs.push({ id: uuid('e1000000-0000-0000-0000-', ++n), organization_id: org, active, features, tplAll, tplVar })
      }
    const templateRows = []
    for (const l of locs) {
      await db.query(`INSERT INTO public.locations (id, features, active, organization_id) VALUES ($1, $2::jsonb, $3, $4)`,
        [l.id, JSON.stringify(l.features), l.active, l.organization_id])
      for (const role of ROLES_WITH_TEMPLATES) {
        if (l.tplAll) templateRows.push({ location_id: l.id, role, employment_type: 'all', permissions: l.tplAll })
        if (l.tplVar) templateRows.push({ location_id: l.id, role, employment_type: 'contractor', permissions: l.tplVar })
      }
    }
    for (const r of templateRows) {
      await db.query(`INSERT INTO public.location_role_permissions (location_id, role, employment_type, permissions) VALUES ($1, $2, $3, $4::jsonb)`,
        [r.location_id, r.role, r.employment_type, JSON.stringify(r.permissions)])
    }
    const org1 = locs.filter((l) => l.organization_id === ORG1)
    const org2 = locs.filter((l) => l.organization_id === ORG2)
    // explicit membership shapes
    const MEMBERSHIPS = {
      none: () => [],
      staffOrg1Half: () => org1.filter((_, i) => i % 2 === 0).map((l) => ({ location_id: l.id, role: 'staff', permissions: {} })),
      receptionOrg1Third: () => org1.filter((_, i) => i % 3 === 0).map((l) => ({ location_id: l.id, role: 'reception', permissions: { mobile: { bookings: false } } })),
      ownerOrg2Off: () => org2.filter((_, i) => i % 2 === 1).map((l) => ({ location_id: l.id, role: 'owner', permissions: { contacts: false, mobile: { contacts: false, ...all4(false) } } })),
    }
    const ORG_LINKS = { none: [], org1: [ORG1], both: [ORG1, ORG2] }
    const profiles = []
    n = 0
    for (const orgs of Object.keys(ORG_LINKS)) for (const mem of Object.keys(MEMBERSHIPS)) for (const emp of ['fte', 'contractor']) {
      profiles.push({ id: uuid('e2000000-0000-0000-0000-', ++n), role: 'staff', emp, orgs: ORG_LINKS[orgs], links: MEMBERSHIPS[mem](), active: true })
    }
    profiles.push({ id: uuid('e2000000-0000-0000-0000-', ++n), role: 'master', emp: 'fte', orgs: [ORG1], links: MEMBERSHIPS.staffOrg1Half(), active: true })
    profiles.push({ id: uuid('e2000000-0000-0000-0000-', ++n), role: 'owner', emp: 'fte', orgs: [ORG1], links: [], active: false })
    profiles.push({ id: uuid('e2000000-0000-0000-0000-', ++n), role: 'staff', emp: 'fte', orgs: [ORG1, ORG2], links: [], active: true, deleted: true })

    for (const p of profiles) {
      await db.query(`INSERT INTO public.profiles (id, role, employment_type, active, deleted_at) VALUES ($1, $2, $3, $4, $5)`,
        [p.id, p.role, p.emp, p.active, p.deleted ? new Date().toISOString() : null])
      for (const l of p.links) {
        await db.query(`INSERT INTO public.profile_locations (profile_id, location_id, role, permissions) VALUES ($1, $2, $3, $4::jsonb)`,
          [p.id, l.location_id, l.role, JSON.stringify(l.permissions)])
      }
      for (const o of p.orgs) await db.query(`INSERT INTO public.profile_organizations (profile_id, organization_id) VALUES ($1, $2)`, [p.id, o])
    }

    const locById = Object.fromEntries(locs.map((l) => [l.id, { id: l.id, features: l.features, active: l.active, organization_id: l.organization_id }]))
    // a fake service-role client for loadRoleTemplatesForLocations
    const fakeDb = { from: () => ({ select: () => ({ in: (_c, ids) => Promise.resolve({ data: templateRows.filter((r) => ids.includes(r.location_id)) }) }) }) }

    // JS: the user getCurrentUser builds (src/lib/auth.js), step for step:
    // explicit links (any studio), master = every ACTIVE studio, the SAAS-4
    // expansion over the admin orgs' ACTIVE studios (real expandOrgAdminAccess),
    // synthetic { role: 'owner', permissions: {} } assignments, the real
    // template loader. An inactive or tombstoned login gets no user (null).
    const jsUser = async (p) => {
      if (!p.active || p.deleted) return null
      const isMaster = p.role === 'master'
      let locations = p.links.map((l) => locById[l.location_id])
      let rolesByLocation = buildRolesByLocation(p.links)
      if (isMaster) locations = locs.filter((l) => l.active === true).map((l) => locById[l.id])
      const orgAdminOrgIds = isMaster ? [] : [...new Set(p.orgs)]
      let synthetic = []
      if (orgAdminOrgIds.length) {
        const orgLocations = locs.filter((l) => orgAdminOrgIds.includes(l.organization_id) && l.active === true).map((l) => locById[l.id])
        const e = expandOrgAdminAccess({ locations, rolesByLocation, orgLocations })
        locations = e.locations
        rolesByLocation = e.rolesByLocation
        synthetic = e.syntheticLocationIds
      }
      const assignmentsByLocation = Object.fromEntries(p.links.map((l) => [l.location_id, { role: l.role, permissions: l.permissions }]))
      for (const id of synthetic) if (!assignmentsByLocation[id]) assignmentsByLocation[id] = { role: 'owner', permissions: {} }
      const { roleTemplatesByLocation } = await loadRoleTemplatesForLocations(fakeDb, { isMaster, rolesByLocation, employmentType: p.emp })
      return { role: isMaster ? 'master' : 'staff', locations, assignmentsByLocation, roleTemplatesByLocation }
    }

    for (const p of profiles) {
      const user = await jsUser(p)
      for (const key of ['contacts', ...PHONE_KEYS]) {
        const fn = key === 'contacts' ? 'private.auth_contact_read_location_ids()' : `private.auth_mobile_can_location_ids('${key}')`
        const [row] = await asUser(db, p.id, `SELECT coalesce(${fn}, '{}') AS ids`)
        const sql = new Set(row.ids)
        for (const l of locs) {
          // Known, pre-existing and out of scope (C131 plan, "Not verified"):
          // for a MASTER, JS passes an inactive studio no location object, so
          // no studio switch applies; SQL applies it. Masters are compared at
          // active studios only. Prod has 0 inactive studios.
          if (p.role === 'master' && l.active !== true) continue
          const js = !user ? false : key === 'contacts'
            ? hasPermissionForLocation(user, l.id, 'contacts') || hasMobilePermissionForLocation(user, l.id, 'contacts')
            : hasMobilePermissionForLocation(user, l.id, key)
          // granted only through the org-admin tier: an org admin with no membership here
          const viaOrg = p.role !== 'master' && p.orgs.includes(l.organization_id) && !p.links.some((x) => x.location_id === l.id)
          cases += 1
          answers[js] += 1
          if (js && viaOrg) orgTier += 1
          if (sql.has(l.id) !== js) mismatches.push({ profile: { ...p, id: undefined, links: p.links.length }, loc: { ...l, id: undefined }, key, js, sql: sql.has(l.id), viaOrg })
        }
      }
    }
    await db.close()
    return { mismatches, cases, answers, orgTier }
  }
  beforeAll(async () => {
    runs.before = await runMatrix([])
    runs.after = await runMatrix([MIG_699])
  }, 600_000)

  it('covers the matrix (not vacuous)', () => {
    // 26 non-masters x 288 studios x 5 keys + the master at the 96 active studios x 5
    expect(runs.after.cases).toBe(26 * 288 * 5 + 96 * 5)
  })

  it('both answers occur, and the org tier grants a real share of them', () => {
    expect(runs.after.answers.true).toBeGreaterThan(2000)
    expect(runs.after.answers.false).toBeGreaterThan(2000)
    expect(runs.after.orgTier).toBeGreaterThan(500)
  })

  it('before 699 the matrix fails exactly on the org tier (it can see the defect)', () => {
    const { mismatches, orgTier } = runs.before
    expect(mismatches.length).toBe(orgTier)
    expect(mismatches.every((x) => x.viaOrg && x.js === true && x.sql === false)).toBe(true)
  })

  it('after 699 it agrees on every combination', () => {
    expect(runs.after.mismatches.slice(0, 5), `${runs.after.mismatches.length} mismatches`).toEqual([])
  })
})

describe('the file aborts as a whole', () => {
  let db
  afterEach(async () => { await db?.close() })

  it('when the contact helper is not the 690 body', async () => {
    db = await bootProd({ before2: `CREATE OR REPLACE FUNCTION private.auth_contact_read_location_ids() RETURNS uuid[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $function$ SELECT '{}'::uuid[] $function$;` })
    expect(await abortMessage(db, MIG_699)).toMatch(/mig 699: private\.auth_contact_read_location_ids is not the mig 690 body/)
    expect(await aclOf(db, FN.mobileCanFor)).toBe(ACL.open)
  }, 60_000)

  it('when the phone core is not the 691 body', async () => {
    db = await bootProd({ before2: `CREATE OR REPLACE FUNCTION private.mobile_can_location_ids_for(p_uid uuid, perm_key text) RETURNS uuid[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $function$ SELECT '{}'::uuid[] $function$;` })
    expect(await abortMessage(db, MIG_699)).toMatch(/mig 699: private\.mobile_can_location_ids_for is not the mig 691 body/)
  }, 60_000)

  it('when a client can write profile_organizations past a master check (org admin would be a self-grant)', async () => {
    db = await bootProd({ before2: `ALTER POLICY profile_organizations_ins ON public.profile_organizations WITH CHECK (profile_id = (SELECT auth.uid()));` })
    expect(await abortMessage(db, MIG_699)).toMatch(/mig 699: profile_organizations admits a non-master client write/)
  }, 60_000)

  it('when anon can write profile_organizations', async () => {
    db = await bootProd({ before2: `GRANT INSERT ON public.profile_organizations TO anon;` })
    expect(await abortMessage(db, MIG_699)).toMatch(/mig 699: profile_organizations admits a non-master client write/)
  }, 60_000)

  it('when a policy calls mobile_can_for (revoking authenticated would 42501 it)', async () => {
    db = await bootProd({ before2: `CREATE POLICY deals_extra ON public.deals FOR SELECT TO authenticated USING (private.mobile_can_for((SELECT auth.uid()), location_id, 'pipeline'));` })
    expect(await abortMessage(db, MIG_699)).toMatch(/mig 699: something still calls private\.mobile_can_for/)
  }, 60_000)
})

describe("the plan's rollback record (POST-677)", () => {
  let db
  afterAll(() => db?.close())

  it('restores the 690 / 691 bodies verbatim and authenticated\'s EXECUTE on mobile_can_for; 699 applies again after it', async () => {
    db = await bootProd({ migrate: [MIG_699] })
    await db['exec'](ROLLBACK_699)
    expect(await md5Of(db, FN.contact)).toBe(PROD_MD5.contact)
    expect(await md5Of(db, FN.core)).toBe(PROD_MD5.core)
    // a re-GRANT appends authenticated after service_role, so compare privileges, not the ACL text
    expect(await canExec(db, FN.mobileCanFor)).toEqual({ authenticated: true, service_role: true, anon: false, public: false })
    expect(await aclOf(db, FN.contact)).toBe(ACL.open)
    expect(await aclOf(db, FN.core)).toBe(ACL.service)
    expect(await reads(db, ORG_ADMIN)).toEqual(shape(0, 0))
    await signedOut(db)
    await db['exec'](MIG_699)
    expect(await reads(db, ORG_ADMIN)).toEqual(shape(3, (t) => (WA.includes(t) ? 1 : 2)))
  }, 60_000)
})
