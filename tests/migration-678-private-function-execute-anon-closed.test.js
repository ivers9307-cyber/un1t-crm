// PRIVATEFNEXEC.1 — behavioural test for migration 678.
//
// Boots PGlite (PostgreSQL 17) with every function prod has in schema
// private (30 Sep 2026: 46, by identity signature) in its live ACL shape:
// 20 with a NULL ACL (built-in PUBLIC EXECUTE), 5 with an explicit PUBLIC
// item + authenticated, auth_is_active_staff() granted to anon and
// authenticated by name, and 20 already closed to anon. Then prod's function
// default privileges as mig 667 left them (global postgres-only; PUBLIC per
// schema in private and extensions). Bodies are stubs except the helpers
// whose behaviour is asserted. Public tables are in their post-677 shape
// (anon holds nothing). It proves:
//
//   * BEFORE: anon executes 26 private functions, PUBLIC 25, authenticated
//     39, service_role 33; a new private function opens to PUBLIC;
//   * AFTER: anon and PUBLIC execute nothing in private; authenticated and
//     service_role execute exactly what they did; a signed-in master and a
//     staff member still read through the policy helpers; a client write
//     still fires a private trigger; a new private function is
//     authenticated + service_role only; public and extensions defaults
//     unchanged;
//   * the self-check aborts the WHOLE file on another grantor's anon grant,
//     an EXECUTE anon inherits through a role, a private function owned by
//     another role, and a database where 677 is not applied; a second run
//     passes; the plan's rollback record restores every ACL and default.
// Fictional ids and values only: the repo is public.

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const MIG_678 = readFileSync(
  path.resolve(import.meta.dirname, '../supabase/migrations/678_private_function_execute_anon_closed.sql'), 'utf8')

// prod ACL shapes, 30 Sep 2026, re-read after 677 was applied (identity
// signatures as pg_proc prints them). Unchanged by 677, which touched no function.
const NULL_ACL = [
  ['auth_can_view_all_profiles', '', 'boolean'], ['auth_is_master', '', 'boolean'],
  ['auth_mobile_can', 'uuid, text', 'boolean'], ['bump_xero_refresh_ts', '', 'trigger'],
  ['guard_at_least_one_master', '', 'trigger'], ['guard_unifi_config_master_only', '', 'trigger'],
  ['log_mutation', '', 'trigger'], ['mobile_can_for', 'uuid, uuid, text', 'boolean'],
  ['sync_contact_person_group', '', 'trigger'], ['sync_group_primary_flags', '', 'trigger'],
  ['touch_landing_page_settings_updated_at', '', 'trigger'], ['touch_orders_updated_at', '', 'trigger'],
  ['touch_org_settings_updated_at', '', 'trigger'], ['touch_organizations_updated_at', '', 'trigger'],
  ['touch_race_events_updated_at', '', 'trigger'], ['touch_race_payments_updated_at', '', 'trigger'],
  ['touch_race_registrations_updated_at', '', 'trigger'], ['touch_race_waves_updated_at', '', 'trigger'],
  ['touch_teams_updated_at', '', 'trigger'], ['wa_phone_from_phone', 'text', 'text'],
]
const PUBLIC_PLUS_AUTH = [
  ['auth_is_admin_at', 'uuid', 'boolean'], ['auth_is_in_organization', 'uuid', 'boolean'],
  ['auth_is_manager_at', 'uuid', 'boolean'], ['auth_is_owner_at', 'uuid', 'boolean'],
  ['get_user_role_at', 'uuid, uuid', 'text'],
]
const ANON_AUTH = [['auth_is_active_staff', '', 'boolean']]
const POSTGRES_ONLY = [
  ['audit_is_pii_key', 'text', 'boolean'], ['audit_is_secret_key', 'text', 'boolean'],
  ['audit_redact', 'jsonb, text[], text, integer', 'jsonb'], ['audit_secret_paths', 'jsonb, text, integer', 'text[]'],
  ['profiles_tombstone_frozen', '', 'trigger'], ['refuse_tombstone_access_row', '', 'trigger'],
  ['shift_template_qualification_same_org', '', 'trigger'],
]
const AUTH_ONLY = [
  ['auth_can_read_shift_assignment', 'uuid, uuid', 'boolean'], ['auth_can_read_shift_block', 'uuid, uuid', 'boolean'],
  ['auth_has_mailbox_grant', 'uuid', 'boolean'], ['auth_has_ticket_mailbox_grant', 'uuid', 'boolean'],
  ['auth_is_manager_at_bridge', 'uuid', 'boolean'],
]
const AUTH_SVC = [
  ['auth_contact_id', '', 'uuid'], ['auth_is_admin_or_head_coach', '', 'boolean'], ['auth_is_in_location', 'uuid', 'boolean'],
  ['auth_is_owner_or_manager', '', 'boolean'], ['auth_is_owner', '', 'boolean'], ['auth_role', '', 'text'],
  ['get_user_role', 'uuid', 'text'], ['is_owner', '', 'boolean'],
]
const sig = ([name, args]) => `private.${name}(${args})`
const list = (fns) => fns.map(sig).join(',\n  ')

// The rollback record from the C76 plan (Task 10 Step 7), verbatim.
const ROLLBACK_678 = `
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA private REVOKE EXECUTE ON FUNCTIONS FROM authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA private GRANT EXECUTE ON FUNCTIONS TO PUBLIC;
GRANT EXECUTE ON FUNCTION
  private.auth_can_view_all_profiles(),
  private.auth_is_admin_at(uuid),
  private.auth_is_in_organization(uuid),
  private.auth_is_manager_at(uuid),
  private.auth_is_master(),
  private.auth_is_owner_at(uuid),
  private.auth_mobile_can(uuid, text),
  private.bump_xero_refresh_ts(),
  private.get_user_role_at(uuid, uuid),
  private.guard_at_least_one_master(),
  private.guard_unifi_config_master_only(),
  private.log_mutation(),
  private.mobile_can_for(uuid, uuid, text),
  private.sync_contact_person_group(),
  private.sync_group_primary_flags(),
  private.touch_landing_page_settings_updated_at(),
  private.touch_orders_updated_at(),
  private.touch_org_settings_updated_at(),
  private.touch_organizations_updated_at(),
  private.touch_race_events_updated_at(),
  private.touch_race_payments_updated_at(),
  private.touch_race_registrations_updated_at(),
  private.touch_race_waves_updated_at(),
  private.touch_teams_updated_at(),
  private.wa_phone_from_phone(text)
TO PUBLIC;
-- the 20 that had a NULL ACL held no named authenticated/service_role item
REVOKE EXECUTE ON FUNCTION
  private.auth_can_view_all_profiles(),
  private.auth_is_master(),
  private.auth_mobile_can(uuid, text),
  private.bump_xero_refresh_ts(),
  private.guard_at_least_one_master(),
  private.guard_unifi_config_master_only(),
  private.log_mutation(),
  private.mobile_can_for(uuid, uuid, text),
  private.sync_contact_person_group(),
  private.sync_group_primary_flags(),
  private.touch_landing_page_settings_updated_at(),
  private.touch_orders_updated_at(),
  private.touch_org_settings_updated_at(),
  private.touch_organizations_updated_at(),
  private.touch_race_events_updated_at(),
  private.touch_race_payments_updated_at(),
  private.touch_race_registrations_updated_at(),
  private.touch_race_waves_updated_at(),
  private.touch_teams_updated_at(),
  private.wa_phone_from_phone(text)
FROM authenticated, service_role;
-- the 5 with an explicit PUBLIC item named authenticated but not service_role
REVOKE EXECUTE ON FUNCTION
  private.auth_is_admin_at(uuid),
  private.auth_is_in_organization(uuid),
  private.auth_is_manager_at(uuid),
  private.auth_is_owner_at(uuid),
  private.get_user_role_at(uuid, uuid)
FROM service_role;
GRANT EXECUTE ON FUNCTION private.auth_is_active_staff() TO anon;
COMMIT;
`

const VERBATIM = {
  auth_is_master: `CREATE FUNCTION private.auth_is_master() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
    SELECT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = (SELECT auth.uid()) AND p.role = 'master' AND p.active)
  $$;`,
  auth_is_in_location: `CREATE FUNCTION private.auth_is_in_location(loc_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
    SELECT loc_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.profiles p WHERE p.id = (SELECT auth.uid()) AND p.active IS NOT FALSE AND p.deleted_at IS NULL
        AND (p.role = 'master' OR EXISTS (SELECT 1 FROM public.profile_locations
               WHERE profile_id = (SELECT auth.uid()) AND location_id = loc_id)))
  $$;`,
  touch_orders_updated_at: `CREATE FUNCTION private.touch_orders_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN NEW.updated_at := now(); RETURN NEW; END $$;`,
}
const stub = ([name, args, ret]) => VERBATIM[name] ?? (ret === 'trigger'
  ? `CREATE FUNCTION private.${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;`
  : `CREATE FUNCTION private.${name}(${args}) RETURNS ${ret} LANGUAGE sql STABLE AS $$ SELECT NULL::${ret} $$;`)

const LOC_A = 'a0000000-0000-0000-0000-00000000000a'
const MASTER = '10000000-0000-0000-0000-000000000001'
const STAFF_A = '10000000-0000-0000-0000-000000000002'
const ORDER = '70000000-0000-0000-0000-000000000001'

const BASE = `
  CREATE ROLE anon NOLOGIN;
  CREATE ROLE authenticated NOLOGIN;
  CREATE ROLE service_role NOLOGIN BYPASSRLS;
  CREATE ROLE other_grantor NOLOGIN;
  CREATE ROLE sneaky NOLOGIN;
  CREATE SCHEMA auth;
  CREATE SCHEMA private;
  CREATE SCHEMA extensions;
  GRANT USAGE ON SCHEMA auth, public, extensions TO anon, authenticated, service_role;
  GRANT USAGE ON SCHEMA private TO authenticated;   -- live: anon and service_role have none

  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
    SELECT nullif(current_setting('request.jwt.claims', true)::json->>'sub', '')::uuid
  $$;
  GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;

  -- public tables in their post-677 shape: anon holds nothing.
  CREATE TABLE public.profiles (id uuid PRIMARY KEY, role text NOT NULL, active boolean DEFAULT true, deleted_at timestamptz);
  CREATE TABLE public.profile_locations (profile_id uuid, location_id uuid, role text NOT NULL, PRIMARY KEY (profile_id, location_id));
  CREATE TABLE public.ble_bridges (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), location_id uuid);
  CREATE TABLE public.orders (id uuid PRIMARY KEY, location_id uuid, note text, updated_at timestamptz);
  REVOKE ALL ON public.profiles, public.profile_locations FROM PUBLIC;
  GRANT SELECT ON public.ble_bridges TO authenticated;
  GRANT SELECT, UPDATE ON public.orders TO authenticated;
  ALTER TABLE public.ble_bridges ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
`

const FUNCTIONS = () => [
  ...[...NULL_ACL, ...PUBLIC_PLUS_AUTH, ...ANON_AUTH, ...POSTGRES_ONLY, ...AUTH_ONLY, ...AUTH_SVC].map(stub),
  `GRANT EXECUTE ON FUNCTION ${list(PUBLIC_PLUS_AUTH)} TO authenticated;`,
  `REVOKE ALL ON FUNCTION ${list([...ANON_AUTH, ...POSTGRES_ONLY, ...AUTH_ONLY, ...AUTH_SVC])} FROM PUBLIC;`,
  `GRANT EXECUTE ON FUNCTION private.auth_is_active_staff() TO anon, authenticated;`,
  `GRANT EXECUTE ON FUNCTION ${list(AUTH_ONLY)} TO authenticated;`,
  `GRANT EXECUTE ON FUNCTION ${list(AUTH_SVC)} TO authenticated, service_role;`,
  // mig 667's function defaults (live since 30 Sep)
  `ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO postgres, service_role;`,
  `ALTER DEFAULT PRIVILEGES FOR ROLE postgres REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;`,
  `ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA private GRANT EXECUTE ON FUNCTIONS TO PUBLIC;`,
  `ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA extensions GRANT EXECUTE ON FUNCTIONS TO PUBLIC;`,
  // live policies (verbatim) and a private trigger a client write fires
  `CREATE POLICY ble_bridges_read ON public.ble_bridges FOR SELECT USING (((SELECT private.auth_is_master() AS auth_is_master) OR private.auth_is_in_location(location_id)));`,
  `CREATE POLICY orders_rw ON public.orders FOR ALL TO authenticated USING (private.auth_is_in_location(location_id)) WITH CHECK (private.auth_is_in_location(location_id));`,
  `CREATE TRIGGER orders_touch BEFORE UPDATE ON public.orders FOR EACH ROW EXECUTE FUNCTION private.touch_orders_updated_at();`,
].join('\n')

const SEED = `
  INSERT INTO public.profiles VALUES ('${MASTER}', 'master', true, NULL), ('${STAFF_A}', 'staff', true, NULL);
  INSERT INTO public.profile_locations VALUES ('${STAFF_A}', '${LOC_A}', 'staff');
  INSERT INTO public.ble_bridges (location_id) VALUES ('${LOC_A}'), ('b0000000-0000-0000-0000-00000000000b');
  INSERT INTO public.orders VALUES ('${ORDER}', '${LOC_A}', 'synthetic', '2000-01-01');
`

let db
const runSql = (text) => db['exec'](text)

async function asUser(uid, ...statements) {
  await runSql('BEGIN')
  try {
    await db.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: uid, role: 'authenticated' })])
    await runSql('SET LOCAL ROLE authenticated')
    let rows = []
    for (const s of statements) rows = (await db.query(s)).rows
    return rows
  } finally {
    await runSql('ROLLBACK')
  }
}

async function census() {
  return (await db.query(`
    SELECT count(*) FILTER (WHERE has_function_privilege('anon', p.oid, 'EXECUTE'))::int AS anon_x,
           count(*) FILTER (WHERE has_function_privilege('authenticated', p.oid, 'EXECUTE'))::int AS auth_x,
           count(*) FILTER (WHERE has_function_privilege('service_role', p.oid, 'EXECUTE'))::int AS svc_x,
           count(*) FILTER (WHERE EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0))::int AS public_x,
           count(*)::int AS total
      FROM pg_proc p WHERE p.pronamespace = 'private'::regnamespace`)).rows[0]
}

/** Every private function's ACL, NULL expanded, as a sorted item set. */
async function fnAcls() {
  const { rows } = await db.query(`
    SELECT p.oid::regprocedure::text AS f,
           coalesce(string_agg(coalesce(r.rolname, 'PUBLIC') || ':' || a.privilege_type, ',' ORDER BY coalesce(r.rolname, 'PUBLIC')), '') AS items
      FROM pg_proc p
      LEFT JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a ON true
      LEFT JOIN pg_roles r ON r.oid = a.grantee
     WHERE p.pronamespace = 'private'::regnamespace
     GROUP BY 1`)
  return Object.fromEntries(rows.map((r) => [r.f, r.items]))
}

async function defaultAcls() {
  const { rows } = await db.query(`
    SELECT coalesce(n.nspname, '<global>') || ' ' || coalesce(r.rolname, 'PUBLIC') || ':' || a.privilege_type AS item
      FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace
      CROSS JOIN LATERAL aclexplode(d.defaclacl) a LEFT JOIN pg_roles r ON r.oid = a.grantee
     WHERE d.defaclrole = 'postgres'::regrole AND d.defaclobjtype = 'f'`)
  return rows.map((r) => r.item).sort()
}

async function newFunctionCan(schema) {
  await runSql(`CREATE FUNCTION ${schema}._t_probe() RETURNS integer LANGUAGE sql AS 'SELECT 1'`)
  const out = {}
  for (const role of ['anon', 'authenticated', 'service_role', 'public']) {
    const { rows: [r] } = await db.query(`SELECT has_function_privilege($1, $2, 'EXECUTE') AS can`, [role, `${schema}._t_probe()`])
    out[role] = r.can
  }
  await runSql(`DROP FUNCTION ${schema}._t_probe()`)
  return out
}
const OPEN = { anon: true, authenticated: true, service_role: true, public: true }
const SIGNED_IN = { anon: false, authenticated: true, service_role: true, public: false }
const SERVER_ONLY = { anon: false, authenticated: false, service_role: true, public: false }

async function boot({ migrate = false, before = '' } = {}) {
  db = new PGlite()
  await runSql(BASE)
  await runSql(FUNCTIONS())
  await runSql(SEED)
  if (before) await runSql(before)
  if (migrate) await runSql(MIG_678)
}

const BEFORE = { anon_x: 26, auth_x: 39, svc_x: 33, public_x: 25, total: 46 }

describe('before 678 — prod after 677 (re-read 30 Sep 2026, 677 applied)', () => {
  beforeAll(() => boot(), 60_000)
  afterAll(() => db?.close())

  it('the census equals prod\'s', async () => {
    expect(await census()).toEqual(BEFORE)
  })

  it('a new private function opens to PUBLIC (mig 667 default)', async () => {
    expect(await newFunctionCan('private')).toEqual(OPEN)
  })
})

describe('after 678', () => {
  beforeAll(() => boot({ migrate: true }), 60_000)
  afterAll(() => db?.close())

  it('anon and PUBLIC execute nothing in private; authenticated and service_role unchanged', async () => {
    expect(await census()).toEqual({ ...BEFORE, anon_x: 0, public_x: 0 })
  })

  it('the defaults: private is authenticated + service_role; public and extensions as 667 left them', async () => {
    expect(await newFunctionCan('private')).toEqual(SIGNED_IN)
    expect(await newFunctionCan('public')).toEqual(SERVER_ONLY)
    expect(await newFunctionCan('extensions')).toEqual(OPEN)
  })

  it('a master and a staff member still read through the policy helpers', async () => {
    expect(await asUser(MASTER, 'SELECT count(*)::int AS n FROM public.ble_bridges')).toEqual([{ n: 2 }])
    expect(await asUser(STAFF_A, 'SELECT count(*)::int AS n FROM public.ble_bridges')).toEqual([{ n: 1 }])
  })

  it('a client write still fires a private trigger', async () => {
    expect(await asUser(STAFF_A, `UPDATE public.orders SET note = 'x' WHERE id = '${ORDER}' RETURNING updated_at > '2000-01-02'::timestamptz AS touched`))
      .toEqual([{ touched: true }])
  })
})

describe('the self-check aborts the whole file', () => {
  afterEach(async () => { await db?.close() })

  async function expectAbort(before, message) {
    await boot({ before })
    const pre = { census: await census(), acls: await fnAcls() }
    await expect(runSql(MIG_678)).rejects.toThrow(message)
    await runSql('ROLLBACK')
    expect({ census: await census(), acls: await fnAcls() }).toEqual(pre)   // nothing applied
  }

  it("when another grantor's anon EXECUTE survives", () => expectAbort(
    `GRANT USAGE ON SCHEMA private TO other_grantor;
     GRANT EXECUTE ON FUNCTION private.audit_redact(jsonb, text[], text, integer) TO other_grantor WITH GRANT OPTION;
     SET ROLE other_grantor; GRANT EXECUTE ON FUNCTION private.audit_redact(jsonb, text[], text, integer) TO anon; RESET ROLE;`,
    /mig 678: anon can still execute: private\.audit_redact/,
  ), 60_000)

  it('when anon inherits EXECUTE through a role', () => expectAbort(
    `GRANT EXECUTE ON FUNCTION private.audit_is_pii_key(text) TO sneaky; GRANT sneaky TO anon;`,
    /mig 678: anon can still execute: private\.audit_is_pii_key\(text\)/,
  ), 60_000)

  it('when a private function is owned by another role', () => expectAbort(
    `ALTER FUNCTION private.auth_role() OWNER TO other_grantor;`,
    /mig 678: private functions not owned by postgres .*auth_role/,
  ), 60_000)

  it('when 677 is not applied (anon still reaches a public table)', () => expectAbort(
    `GRANT SELECT ON public.ble_bridges TO anon;`,
    /mig 678: apply 677 first \(anon still reaches: ble_bridges\)/,
  ), 60_000)

  it('a second run passes (idempotent)', async () => {
    await boot({ migrate: true })
    await expect(runSql(MIG_678)).resolves.toBeDefined()
    expect((await census()).anon_x).toBe(0)
  }, 60_000)
})

describe("the plan's rollback record", () => {
  afterAll(() => db?.close())

  it('restores every private function ACL and the default rows exactly (as sets)', async () => {
    await boot()
    const before = { fns: await fnAcls(), defaults: await defaultAcls() }
    await runSql(MIG_678)
    await runSql(ROLLBACK_678)
    expect(await fnAcls()).toEqual(before.fns)
    expect(await defaultAcls()).toEqual(before.defaults)
    expect(await census()).toEqual(BEFORE)
  }, 60_000)
})
