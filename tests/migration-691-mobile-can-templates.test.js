// MOBILECANTEMPLATES.1 — behavioural test for migration 691.
//
// Prod on 1-2 Oct 2026 (read-only, Supabase MCP): private.mobile_can_for (626
// body) and private.auth_mobile_can (550 body) VERBATIM, both with the
// post-678 EXECUTE (postgres, authenticated, service_role; no PUBLIC, no
// anon), the post-667/678 default ACLs (global: postgres only; private:
// + authenticated, service_role), private.mobile_permission_defaults with
// its 16 rows (no reception), private.permission_key_bundles from
// KEY_BUNDLES, location_role_permissions with RLS on and no policy, and the
// 15 policies on activities / bookings / deals / notes / whatsapp_* VERBATIM
// (per-row auth_mobile_can). Then the REAL 691 file, and:
//   * the three live shapes: a head coach whose 'all' template turns phone
//     WhatsApp off, a contractor whose employment-type template turns phone
//     Tasks off (both read before, nothing after), an fte whose template turns
//     phone Bookings ON (nothing before, the studio's bookings after);
//   * reception gets the JS defaults; owners, masters and members unchanged;
//     writes follow reads (WITH CHECK);
//   * THE PARITY MATRIX: 75 profiles x 60 studios x 4 keys = 18,000 cases, SQL
//     (the array wrapper AND the kept per-row entry points) === the real
//     hasMobilePermissionForLocation;
//   * the policies call the wrapper once per statement (InitPlan, no SubPlan);
//   * EXECUTE; the policy texts; idempotent; abort cases; the rollback record.
// Fictional ids only: the repo is public.

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { boot, asUser, IDS, abortMessage, policiesOf } from './helpers/member-write-sweep.js'
import { hasMobilePermissionForLocation } from '../src/lib/permissions.js'
import { mergeTemplates } from '../shared/permissions.js'
import { KEY_BUNDLES } from '../shared/permission-bundles.js'

const MIG_691 = readFileSync(path.resolve(import.meta.dirname,
  '../supabase/migrations/691_mobile_permissions_follow_role_templates.sql'), 'utf8')

const KEYS = ['pipeline', 'tasks', 'bookings', 'whatsapp']
const { LOC_A, LOC_B } = IDS
const HC_A = '10000000-0000-0000-0000-0000000000c1'    // head coach at A ('all' template: phone WhatsApp off)
const REC_A = '10000000-0000-0000-0000-0000000000c2'   // reception at A (no defaults today)
const CONTRACT_ROW = '{"mobile": {"tasks": false}}'
const FTE_ROW = '{"mobile": {"bookings": true}}'
const HC_ALL_ROW = '{"mobile": {"whatsapp": false}}'
// proacl of the two kept functions on prod since mig 678 (2 Oct 2026).
const KEPT_ACL = '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'

// The 15 policies, verbatim (pg_policies, 1-2 Oct 2026). Old text per key:
const OLD = (k) => `private.auth_mobile_can(location_id, '${k}'::text)`
const OLD_ACT = `(${OLD('tasks')} OR ${OLD('pipeline')})`
// New text per key: PostgreSQL 17's deparse of the file's expression,
// location_id = ANY ((SELECT private.auth_mobile_can_location_ids('<k>'))::uuid[]).
const NEW = (k) => `(location_id = ANY (( SELECT private.auth_mobile_can_location_ids('${k}'::text) AS auth_mobile_can_location_ids)::uuid[]))`
const NEW_ACT = `(${NEW('tasks')} OR ${NEW('pipeline')})`
const POLICY_KEYS = {
  activities: 'act', bookings: 'bookings', deals: 'pipeline', notes: 'pipeline',
  whatsapp_conversations: 'whatsapp', whatsapp_messages: 'whatsapp', whatsapp_templates: 'whatsapp',
}
const TABLE_NAMES = Object.keys(POLICY_KEYS)
const RW_TABLES = ['activities', 'bookings', 'deals', 'notes']
const WA_POLICY = { whatsapp_conversations: 'wa_conv_select', whatsapp_messages: 'wa_msg_select', whatsapp_templates: 'wa_tmpl_select' }

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
  -- prod's function default ACLs since migs 667 and 678: a function postgres
  -- creates is executable by postgres only, plus authenticated and
  -- service_role in schema private.
  ALTER DEFAULT PRIVILEGES FOR ROLE postgres REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
  ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA private GRANT EXECUTE ON FUNCTIONS TO authenticated, service_role;
  REVOKE EXECUTE ON FUNCTION private.auth_is_master() FROM PUBLIC, anon;
  GRANT EXECUTE ON FUNCTION private.auth_is_master() TO authenticated, service_role;

  ALTER TABLE public.locations ADD COLUMN features jsonb NOT NULL DEFAULT '{}'::jsonb;
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
  ${TABLE_NAMES.map((t) => `CREATE TABLE public.${t} (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), location_id uuid);`).join('\n')}
  ${['whatsapp_conversations', 'whatsapp_messages', 'whatsapp_templates'].map((t) => `REVOKE INSERT, UPDATE, DELETE ON public.${t} FROM authenticated;`).join('\n')}
  CREATE FUNCTION private.mobile_can_for(p_uid uuid, loc_id uuid, perm_key text) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $fn$${MOBILE_CAN_FOR_626}$fn$;
  CREATE FUNCTION private.auth_mobile_can(loc_id uuid, perm_key text) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $fn$${AUTH_MOBILE_CAN_550}$fn$;
`

const POLICIES = `
  ${RW_TABLES.map((t) => {
    const e = t === 'activities' ? `(private.auth_mobile_can(location_id, 'tasks') OR private.auth_mobile_can(location_id, 'pipeline'))`
      : `private.auth_mobile_can(location_id, '${POLICY_KEYS[t]}')`
    return `ALTER TABLE public.${t} ENABLE ROW LEVEL SECURITY;
      CREATE POLICY ${t}_select ON public.${t} FOR SELECT TO authenticated USING (${e});
      CREATE POLICY ${t}_insert ON public.${t} FOR INSERT TO authenticated WITH CHECK (${e});
      CREATE POLICY ${t}_update ON public.${t} FOR UPDATE TO authenticated USING (${e}) WITH CHECK (${e});`
  }).join('\n')}
  ${Object.entries(WA_POLICY).map(([t, p]) => `ALTER TABLE public.${t} ENABLE ROW LEVEL SECURITY;
      CREATE POLICY ${p} ON public.${t} FOR SELECT TO authenticated USING (private.auth_mobile_can(location_id, 'whatsapp'));`).join('\n')}
`

const SEED = `
  INSERT INTO private.permission_key_bundles VALUES ${BUNDLE_ROWS};
  INSERT INTO private.mobile_permission_defaults (role, key, allowed) VALUES
    ('staff','pipeline',false),('staff','tasks',true),('staff','bookings',false),('staff','whatsapp',false),
    ('head_coach','pipeline',true),('head_coach','tasks',true),('head_coach','bookings',true),('head_coach','whatsapp',true),
    ('manager','pipeline',true),('manager','tasks',true),('manager','bookings',true),('manager','whatsapp',true),
    ('owner','pipeline',true),('owner','tasks',true),('owner','bookings',true),('owner','whatsapp',true);
  INSERT INTO public.profiles (id, role) VALUES ('${HC_A}', 'head_coach'), ('${REC_A}', 'reception');
  INSERT INTO public.profile_locations (profile_id, location_id, role) VALUES ('${HC_A}', '${LOC_A}', 'head_coach'), ('${REC_A}', '${LOC_A}', 'reception');
  -- the 1 Oct shapes
  UPDATE public.profiles SET employment_type = 'contractor' WHERE id = '${IDS.STAFF_A}';
  INSERT INTO public.location_role_permissions (location_id, role, employment_type, permissions) VALUES
    ('${LOC_A}', 'staff', 'contractor', '${CONTRACT_ROW}'),
    ('${LOC_A}', 'staff', 'fte', '${FTE_ROW}'),
    ('${LOC_A}', 'head_coach', 'all', '${HC_ALL_ROW}');
  ${TABLE_NAMES.map((t) => `INSERT INTO public.${t} (location_id) VALUES ('${LOC_A}'), ('${LOC_B}');`).join('\n')}
`

// Task 5 Step 6's rollback, verbatim. Keep the two in step.
const ROLLBACK_691 = `
BEGIN;
SET LOCAL lock_timeout = '5s';
${RW_TABLES.map((t) => {
  const e = t === 'activities' ? `(private.auth_mobile_can(location_id, 'tasks'::text) OR private.auth_mobile_can(location_id, 'pipeline'::text))`
    : `private.auth_mobile_can(location_id, '${POLICY_KEYS[t]}'::text)`
  return `ALTER POLICY ${t}_select ON public.${t} USING (${e});
ALTER POLICY ${t}_insert ON public.${t} WITH CHECK (${e});
ALTER POLICY ${t}_update ON public.${t} USING (${e}) WITH CHECK (${e});`
}).join('\n')}
${Object.entries(WA_POLICY).map(([t, p]) => `ALTER POLICY ${p} ON public.${t} USING (private.auth_mobile_can(location_id, 'whatsapp'::text));`).join('\n')}
CREATE OR REPLACE FUNCTION private.mobile_can_for(p_uid uuid, loc_id uuid, perm_key text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $fn$${MOBILE_CAN_FOR_626}$fn$;
CREATE OR REPLACE FUNCTION private.auth_mobile_can(loc_id uuid, perm_key text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $fn$${AUTH_MOBILE_CAN_550}$fn$;
DROP FUNCTION private.auth_mobile_can_location_ids(text);
DROP FUNCTION private.mobile_can_location_ids_for(uuid, text);
DELETE FROM private.mobile_permission_defaults WHERE role = 'reception';
COMMIT;
`

const bootProd = (opts = {}) => boot({ tables: TABLES, policies: POLICIES, seed: SEED, after677: true, ...opts })
const count = async (db, uid, t) => (await asUser(db, uid, `SELECT count(*)::int AS n FROM public.${t}`))[0].n
// Sequential on purpose: asUser opens and rolls back a transaction on the one
// PGlite connection, so parallel calls would interleave.
const reads = async (db, uid) => { const out = {}; for (const t of TABLE_NAMES) out[t] = await count(db, uid, t); return out }
const only = (n, keys) => Object.fromEntries(TABLE_NAMES.map((t) => [t, keys.includes(t) ? n : 0]))
const WA = ['whatsapp_conversations', 'whatsapp_messages', 'whatsapp_templates']
const keptAcls = async (db) => (await db.query(`SELECT p.oid::regprocedure::text AS fn, p.proacl::text AS acl FROM pg_proc p
  WHERE p.oid IN ('private.mobile_can_for(uuid,uuid,text)'::regprocedure, 'private.auth_mobile_can(uuid,text)'::regprocedure) ORDER BY 1`)).rows

describe('before 691: prod on 1-2 Oct 2026 (after 677 and 678)', () => {
  let db
  beforeAll(async () => { db = await bootProd() }, 60_000)
  afterAll(() => db?.close())

  it('templates are ignored: the head coach reads WhatsApp, the contractor reads activities, the fte reads no bookings', async () => {
    expect(await reads(db, HC_A)).toEqual(only(1, TABLE_NAMES))
    expect(await reads(db, IDS.STAFF_A)).toEqual(only(1, ['activities']))
    expect(await count(db, IDS.STAFF_MEMBER, 'bookings')).toBe(0)
  })

  it('reception reads nothing (no defaults rows)', async () => {
    expect(await reads(db, REC_A)).toEqual(only(0, []))
  })

  it('the policies are the 1 Oct per-row texts', async () => {
    const ps = await policiesOf(db, TABLE_NAMES)
    expect(ps).toHaveLength(15)
    for (const p of ps) {
      const want = POLICY_KEYS[p.tablename] === 'act' ? OLD_ACT : OLD(POLICY_KEYS[p.tablename])
      for (const e of [p.qual, p.with_check].filter(Boolean)) expect(e).toBe(want)
    }
  })

  it('the kept functions carry the post-678 EXECUTE (no PUBLIC, no anon)', async () => {
    expect(await keptAcls(db)).toEqual([
      { fn: 'private.auth_mobile_can(uuid,text)', acl: KEPT_ACL },
      { fn: 'private.mobile_can_for(uuid,uuid,text)', acl: KEPT_ACL },
    ])
  })
})

describe('after 691', () => {
  let db
  beforeAll(async () => { db = await bootProd({ migrate: [MIG_691] }) }, 60_000)
  afterAll(() => db?.close())

  it('the head coach loses WhatsApp only; the contractor loses activities; the fte gains bookings', async () => {
    expect(await reads(db, HC_A)).toEqual(only(1, ['activities', 'bookings', 'deals', 'notes']))
    expect(await reads(db, IDS.STAFF_A)).toEqual(only(0, []))
    expect(await count(db, IDS.STAFF_MEMBER, 'bookings')).toBe(1)
    expect(await count(db, IDS.STAFF_MEMBER, 'activities')).toBe(1)
  })

  it('reception gets the JS defaults (tasks, bookings, whatsapp; no pipeline)', async () => {
    expect(await reads(db, REC_A)).toEqual(only(1, ['activities', 'bookings', ...WA]))
  })

  it('owners, masters, other studios and members read exactly what they did', async () => {
    expect(await reads(db, IDS.OWNER_A)).toEqual(only(1, TABLE_NAMES))
    expect(await reads(db, IDS.MASTER)).toEqual(only(2, TABLE_NAMES))
    expect(await reads(db, IDS.STAFF_B)).toEqual(only(1, ['activities']))
    expect(await reads(db, IDS.MEMBER_UID)).toEqual(only(0, []))
  })

  it('writes follow reads (WITH CHECK): the contractor cannot add a task, reception can', async () => {
    await expect(asUser(db, IDS.STAFF_A, `INSERT INTO public.activities (location_id) VALUES ('${LOC_A}')`))
      .rejects.toThrow(/row-level security/)
    await expect(asUser(db, REC_A, `INSERT INTO public.activities (location_id) VALUES ('${LOC_A}')`)).resolves.toBeDefined()
    await expect(asUser(db, REC_A, `INSERT INTO public.deals (location_id) VALUES ('${LOC_A}')`)).rejects.toThrow(/row-level security/)
    await expect(asUser(db, IDS.STAFF_MEMBER, `INSERT INTO public.bookings (location_id) VALUES ('${LOC_B}')`)).rejects.toThrow(/row-level security/)
    await expect(asUser(db, IDS.STAFF_MEMBER, `INSERT INTO public.bookings (location_id) VALUES ('${LOC_A}')`)).resolves.toBeDefined()
  })

  it('an inactive or deleted profile reads nothing', async () => {
    await db.query(`UPDATE public.profiles SET active = false WHERE id = $1`, [IDS.OWNER_A])
    expect(await reads(db, IDS.OWNER_A)).toEqual(only(0, []))
    await db.query(`UPDATE public.profiles SET active = true, deleted_at = now() WHERE id = $1`, [IDS.OWNER_A])
    expect(await reads(db, IDS.OWNER_A)).toEqual(only(0, []))
    await db.query(`UPDATE public.profiles SET deleted_at = NULL WHERE id = $1`, [IDS.OWNER_A])
    expect(await reads(db, IDS.OWNER_A)).toEqual(only(1, TABLE_NAMES))
  })

  it('the studio switch and the bundle bind masters too; one of two owning bundles is enough', async () => {
    for (const f of ['{"whatsapp": false}', '{"bundle_messaging": false, "bundle_marketing": false}', '{"whatsapp": true, "bundle_messaging": false, "bundle_marketing": false}']) {
      await db.query(`UPDATE public.locations SET features = $1::jsonb WHERE id = $2`, [f, LOC_A])
      expect(await count(db, IDS.MASTER, 'whatsapp_messages')).toBe(1)
      expect(await count(db, IDS.OWNER_A, 'whatsapp_messages')).toBe(0)
    }
    await db.query(`UPDATE public.locations SET features = '{"bundle_messaging": false}'::jsonb WHERE id = $1`, [LOC_A])
    expect(await count(db, IDS.OWNER_A, 'whatsapp_messages')).toBe(1)
    await db.query(`UPDATE public.locations SET features = '{}'::jsonb WHERE id = $1`, [LOC_A])
  })

  it('the kept entry points agree with the wrapper', async () => {
    for (const uid of [HC_A, IDS.STAFF_A, IDS.STAFF_MEMBER, REC_A, IDS.OWNER_A, IDS.MASTER]) {
      for (const k of KEYS) {
        const [w] = await asUser(db, uid, `SELECT coalesce(private.auth_mobile_can_location_ids('${k}'), '{}') AS ids`)
        const [a] = await asUser(db, uid, `SELECT coalesce(array_agg(id ORDER BY id), '{}') AS ids FROM public.locations WHERE private.auth_mobile_can(id, '${k}')`)
        const [f] = await asUser(db, uid, `SELECT coalesce(array_agg(id ORDER BY id), '{}') AS ids FROM public.locations WHERE private.mobile_can_for((SELECT auth.uid()), id, '${k}')`)
        expect(a.ids, `${uid} ${k} auth_mobile_can`).toEqual(w.ids)
        expect(f.ids, `${uid} ${k} mobile_can_for`).toEqual(w.ids)
      }
    }
  })

  it('the policies evaluate the resolver once per statement (InitPlan), never per row', async () => {
    for (const t of TABLE_NAMES) {
      const rows = await asUser(db, IDS.OWNER_A, `EXPLAIN SELECT count(*) FROM public.${t}`)
      const plan = rows.map((r) => r['QUERY PLAN']).join('\n')
      expect(plan, t).toMatch(/InitPlan/)
      expect(plan, t).not.toMatch(/SubPlan|auth_mobile_can\(|mobile_can_for\(/)
    }
  })

  it('the 15 policies: same names, commands and roles; the new texts', async () => {
    const ps = await policiesOf(db, TABLE_NAMES)
    expect(ps).toHaveLength(15)
    for (const p of ps) {
      expect(p.roles).toBe('{authenticated}')
      expect(p.permissive).toBe('PERMISSIVE')
      const want = POLICY_KEYS[p.tablename] === 'act' ? NEW_ACT : NEW(POLICY_KEYS[p.tablename])
      if (p.cmd !== 'INSERT') expect(p.qual, `${p.policyname} USING`).toBe(want)
      if (p.cmd === 'INSERT' || p.cmd === 'UPDATE') expect(p.with_check, `${p.policyname} CHECK`).toBe(want)
    }
  })

  it('EXECUTE: the wrapper for authenticated + service_role; the core for service_role only; anon and PUBLIC neither', async () => {
    const { rows: [r] } = await db.query(`SELECT
      has_function_privilege('authenticated', 'private.auth_mobile_can_location_ids(text)', 'EXECUTE') wa,
      has_function_privilege('service_role', 'private.auth_mobile_can_location_ids(text)', 'EXECUTE') ws,
      has_function_privilege('anon', 'private.auth_mobile_can_location_ids(text)', 'EXECUTE') wn,
      has_function_privilege('authenticated', 'private.mobile_can_location_ids_for(uuid,text)', 'EXECUTE') ca,
      has_function_privilege('service_role', 'private.mobile_can_location_ids_for(uuid,text)', 'EXECUTE') cs,
      has_function_privilege('anon', 'private.mobile_can_location_ids_for(uuid,text)', 'EXECUTE') cn,
      has_function_privilege('public', 'private.mobile_can_location_ids_for(uuid,text)', 'EXECUTE') cp,
      has_function_privilege('public', 'private.auth_mobile_can_location_ids(text)', 'EXECUTE') wp`)
    expect(r).toEqual({ wa: true, ws: true, wn: false, ca: false, cs: true, cn: false, cp: false, wp: false })
  })

  it('the kept functions keep their OID-bound ACL (CREATE OR REPLACE)', async () => {
    expect(await keptAcls(db)).toEqual([
      { fn: 'private.auth_mobile_can(uuid,text)', acl: KEPT_ACL },
      { fn: 'private.mobile_can_for(uuid,uuid,text)', acl: KEPT_ACL },
    ])
  })

  it('a signed-in user cannot call the core for someone else', async () => {
    await expect(asUser(db, IDS.STAFF_A, `SELECT private.mobile_can_location_ids_for('${IDS.OWNER_A}', 'pipeline')`))
      .rejects.toThrow(/permission denied for function mobile_can_location_ids_for/)
  })

  it('the defaults table holds the 20 JS rows', async () => {
    const { rows } = await db.query(`SELECT role, key, allowed FROM private.mobile_permission_defaults ORDER BY 1, 2`)
    expect(rows).toHaveLength(20)
    expect(rows.filter((r) => r.role === 'reception')).toEqual([
      { role: 'reception', key: 'bookings', allowed: true }, { role: 'reception', key: 'pipeline', allowed: false },
      { role: 'reception', key: 'tasks', allowed: true }, { role: 'reception', key: 'whatsapp', allowed: true }])
  })

  it('a second run passes and changes nothing', async () => {
    // The earlier asUser calls leave request.jwt.claims defined as '' once
    // their transactions roll back. Prod's auth.uid() reads '' as no user
    // (nullif); the harness's reduced one would try ''::json, so the
    // self-check's no-user probe gets an explicit empty claim set instead.
    await db.query(`SELECT set_config('request.jwt.claims', '{}', false)`)
    await expect(db['exec'](MIG_691)).resolves.toBeDefined()
    expect(await reads(db, HC_A)).toEqual(only(1, ['activities', 'bookings', 'deals', 'notes']))
    expect(await reads(db, REC_A)).toEqual(only(1, ['activities', 'bookings', ...WA]))
  })
})

describe('THE PARITY MATRIX: SQL === hasMobilePermissionForLocation (75 profiles x 60 studios x 4 keys)', () => {
  let db
  const mismatches = []
  let cases = 0
  const all4 = (v) => Object.fromEntries(KEYS.map((k) => [k, v]))
  const FEATURES = [
    {},
    all4(false),
    { bundle_sales: false, bundle_members: false, bundle_messaging: false, bundle_marketing: false },
    { ...all4(true), bundle_sales: false, bundle_members: false, bundle_messaging: false, bundle_marketing: false },
    { bundle_messaging: false },
  ]
  const TPL_ALL = [null, { mobile: all4(true) }, { mobile: all4(false) }, all4(false)]   // last: web-level only
  const TPL_VAR = [null, { mobile: all4(true) }, { mobile: all4(false) }]
  const ROLES = ['owner', 'manager', 'head_coach', 'staff', 'reception']
  const OVERRIDES = [{}, { mobile: all4(true) }, { mobile: all4(false) }, all4(false),
    { mobile: 'tasks' }, { mobile: ['tasks', 'whatsapp'] }, { mobile: { tasks: 'true', whatsapp: null } }]
  const EMP = ['fte', 'contractor']
  const uuid = (prefix, n) => `${prefix}${String(n).padStart(12, '0')}`

  beforeAll(async () => {
    db = await bootProd({ migrate: [MIG_691] })
    const locs = []
    let n = 0
    for (const features of FEATURES) for (const tplAll of TPL_ALL) for (const tplVar of TPL_VAR) {
      locs.push({ id: uuid('d0000000-0000-0000-0000-', ++n), features, tplAll, tplVar })
    }
    const profiles = []
    n = 0
    for (const role of ROLES) for (const override of OVERRIDES) for (const emp of EMP) {
      profiles.push({ id: uuid('e0000000-0000-0000-0000-', ++n), role, override, emp, member: true, active: true })
    }
    profiles.push({ id: uuid('e0000000-0000-0000-0000-', ++n), role: 'staff', override: {}, emp: 'fte', member: false, active: true })   // no membership
    profiles.push({ id: uuid('e0000000-0000-0000-0000-', ++n), master: true, role: 'master', override: {}, emp: 'fte', member: false, active: true })
    profiles.push({ id: uuid('e0000000-0000-0000-0000-', ++n), master: true, role: 'owner', override: { mobile: all4(false) }, emp: 'contractor', member: true, active: true })
    profiles.push({ id: uuid('e0000000-0000-0000-0000-', ++n), role: 'owner', override: {}, emp: 'fte', member: true, active: false })    // deactivated
    profiles.push({ id: uuid('e0000000-0000-0000-0000-', ++n), role: 'owner', override: {}, emp: 'fte', member: true, active: true, deleted: true })

    const q = (s, p) => db.query(s, p)
    for (const l of locs) {
      await q(`INSERT INTO public.locations (id, features) VALUES ($1, $2::jsonb)`, [l.id, JSON.stringify(l.features)])
      if (l.tplAll) await q(`INSERT INTO public.location_role_permissions (location_id, role, employment_type, permissions)
        SELECT $1, r, 'all', $3::jsonb FROM unnest($2::text[]) r`, [l.id, ROLES, JSON.stringify(l.tplAll)])
      if (l.tplVar) await q(`INSERT INTO public.location_role_permissions (location_id, role, employment_type, permissions)
        SELECT $1, r, 'contractor', $3::jsonb FROM unnest($2::text[]) r`, [l.id, ROLES, JSON.stringify(l.tplVar)])
    }
    const locIds = locs.map((l) => l.id)
    for (const p of profiles) {
      await q(`INSERT INTO public.profiles (id, role, employment_type, active, deleted_at) VALUES ($1, $2, $3, $4, $5)`,
        [p.id, p.master ? 'master' : p.role, p.emp, p.active, p.deleted ? new Date().toISOString() : null])
      if (p.member) {
        await q(`INSERT INTO public.profile_locations (profile_id, location_id, role, permissions)
          SELECT $1, l, $3, $4::jsonb FROM unnest($2::uuid[]) l`, [p.id, locIds, p.role, JSON.stringify(p.override)])
      }
    }

    for (const p of profiles) {
      // JS: the user getCurrentUser would build (null for an inactive or deleted login).
      const active = p.active && !p.deleted
      const memberLocs = p.member ? locs : []
      const user = !active ? null : {
        role: p.master ? 'master' : p.role,
        assignmentsByLocation: Object.fromEntries(memberLocs.map((l) => [l.id, { role: p.role, permissions: p.override }])),
        locations: (p.master ? locs : memberLocs).map((l) => ({ id: l.id, role: p.role, features: l.features })),
        roleTemplatesByLocation: p.master ? {} : Object.fromEntries(memberLocs
          .map((l) => [l.id, mergeTemplates(l.tplAll, p.emp === 'contractor' ? l.tplVar : null)])
          .filter(([, t]) => t)),
      }
      for (const key of KEYS) {
        const [row] = await asUser(db, p.id, `SELECT coalesce(private.auth_mobile_can_location_ids('${key}'), '{}') AS ids`)
        const sql = new Set(row.ids)
        for (const l of locs) {
          const js = user ? hasMobilePermissionForLocation(user, l.id, key) : false
          cases += 1
          if (sql.has(l.id) !== js) mismatches.push({ profile: { ...p, id: undefined }, loc: { ...l, id: undefined }, key, js, sql: sql.has(l.id) })
        }
      }
    }
  }, 600_000)
  afterAll(() => db?.close())

  it('covers the matrix (not vacuous)', () => {
    expect(cases).toBe((5 * 7 * 2 + 5) * (5 * 4 * 3) * 4)   // 75 x 60 x 4 = 18,000
  })

  it('agrees on every combination', () => {
    expect(mismatches.slice(0, 5), `${mismatches.length} mismatches`).toEqual([])
  })

  it('the kept per-row entry points agree with the wrapper on the matrix too', async () => {
    // One profile per role x override shape (fte and contractor), every studio, every key.
    const { rows } = await db.query(`SELECT id FROM public.profiles WHERE id::text LIKE 'e0000000-%' ORDER BY id`)
    let checked = 0
    for (const { id } of rows) {
      for (const k of KEYS) {
        const [r] = await asUser(db, id, `SELECT
          coalesce(private.auth_mobile_can_location_ids('${k}'), '{}') AS w,
          coalesce((SELECT array_agg(l.id ORDER BY l.id) FROM public.locations l WHERE private.auth_mobile_can(l.id, '${k}')), '{}') AS a,
          coalesce((SELECT array_agg(l.id ORDER BY l.id) FROM public.locations l WHERE private.mobile_can_for((SELECT auth.uid()), l.id, '${k}')), '{}') AS f`)
        expect(r.a, `${id} ${k}`).toEqual(r.w)
        expect(r.f, `${id} ${k}`).toEqual(r.w)
        checked += 1
      }
    }
    expect(checked).toBe(75 * 4)
  }, 600_000)
})

describe('the file aborts as a whole', () => {
  let db
  afterEach(async () => { await db?.close() })

  it('when another policy calls auth_mobile_can (re-plan)', async () => {
    db = await bootProd({ before: `CREATE POLICY deals_extra ON public.deals FOR SELECT TO authenticated USING (private.auth_mobile_can(location_id, 'pipeline'));` })
    expect(await abortMessage(db, MIG_691)).toMatch(/mig 691: a policy outside the 15 calls the per-row phone resolver/)
    expect(await count(db, HC_A, 'whatsapp_messages')).toBe(1)
  }, 60_000)

  it('when one of the 15 is not the 1 Oct text (e.g. C132 landed first)', async () => {
    db = await bootProd({ before: `ALTER POLICY activities_select ON public.activities USING (private.auth_mobile_can(location_id, 'tasks'));` })
    expect(await abortMessage(db, MIG_691)).toMatch(/mig 691: these policies are not the 1 Oct texts; re-plan: activities\.activities_select/)
  }, 60_000)

  it('when mobile_can_for is not the body it was written against', async () => {
    db = await bootProd({ before: `CREATE OR REPLACE FUNCTION private.mobile_can_for(p_uid uuid, loc_id uuid, perm_key text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $fn$ SELECT true $fn$;` })
    expect(await abortMessage(db, MIG_691)).toMatch(/mig 691: private\.mobile_can_for is not the mig 626 body/)
  }, 60_000)

  it('when location_role_permissions admits a client write (templates would become a self-grant path)', async () => {
    db = await bootProd({ before: `CREATE POLICY lrp_w ON public.location_role_permissions FOR UPDATE TO authenticated USING (true);` })
    expect(await abortMessage(db, MIG_691)).toMatch(/mig 691: public\.location_role_permissions has a policy/)
  }, 60_000)

  it('when a client role can write profiles (role / employment_type decide RLS)', async () => {
    db = await bootProd({ before: `GRANT UPDATE (employment_type) ON public.profiles TO authenticated;` })
    expect(await abortMessage(db, MIG_691)).toMatch(/mig 691: a client role can write public\.profiles/)
  }, 60_000)

  it('when the defaults table is not the 16 measured rows', async () => {
    db = await bootProd({ before: `UPDATE private.mobile_permission_defaults SET allowed = true WHERE role = 'staff' AND key = 'whatsapp';` })
    expect(await abortMessage(db, MIG_691)).toMatch(/mig 691: private\.mobile_permission_defaults is not the 1 Oct seed/)
  }, 60_000)
})

describe("the plan's rollback record", () => {
  let db
  afterAll(() => db?.close())

  it('restores the per-row policies, the two old bodies and the 16 rows, and drops the new functions', async () => {
    db = await bootProd({ migrate: [MIG_691] })
    await db['exec'](ROLLBACK_691)
    const ps = await policiesOf(db, TABLE_NAMES)
    for (const p of ps) {
      const want = POLICY_KEYS[p.tablename] === 'act' ? OLD_ACT : OLD(POLICY_KEYS[p.tablename])
      for (const e of [p.qual, p.with_check].filter(Boolean)) expect(e).toBe(want)
    }
    const { rows: [r] } = await db.query(`SELECT
      to_regprocedure('private.auth_mobile_can_location_ids(text)') AS w,
      to_regprocedure('private.mobile_can_location_ids_for(uuid,text)') AS c,
      (SELECT count(*)::int FROM private.mobile_permission_defaults) AS n`)
    expect(r).toEqual({ w: null, c: null, n: 16 })
    expect(await keptAcls(db)).toEqual([
      { fn: 'private.auth_mobile_can(uuid,text)', acl: KEPT_ACL },
      { fn: 'private.mobile_can_for(uuid,uuid,text)', acl: KEPT_ACL },
    ])
    expect(await reads(db, HC_A)).toEqual(only(1, TABLE_NAMES))
    expect(await reads(db, IDS.STAFF_A)).toEqual(only(1, ['activities']))
  }, 60_000)
})
