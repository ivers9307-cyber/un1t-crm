// SHIFTCLIENTWRITE.1 — behavioural GRANT test for migration 676.
//
// No local Supabase stack exists, so a grant change otherwise gets its first
// execution on prod. This boots PGlite (PostgreSQL 17) with Supabase's
// DEFAULT PRIVILEGES (ALL on every new public table for anon, authenticated
// and service_role), the two shift tables in PROD column order, the prod
// helpers and all eight prod policies verbatim (their deparsed text pinned
// against prod's pg_policies), the updated_at triggers with prod's EXECUTE,
// and the prod grant history: the REAL mig 646 file, then mig 668's section
// on these two tables verbatim (prod state on 30 Sep: authenticated=awd +
// 646's column SELECT list, anon nothing). Then:
//
//   * BEFORE: a head coach rewrites their OWN paid window and forges an
//     arrival stamp, puts a person from another studio on a shift, and
//     deletes a block (its assignments cascade away), all with bare SQL from
//     their own session; a plain coach holds the privilege (the policy is the
//     only fence);
//   * AFTER: no signed-in role (coach, head coach, owner, master) can
//     INSERT, UPDATE or DELETE either table; every column ACL is
//     byte-identical, so the coach's Today read, the nested swap embed and
//     the manager's draft-block read return the same rows; withheld columns
//     stay refused; the two SELECT policies are untouched; the service role
//     still inserts, updates (the trigger fires) and deletes (the cascade
//     runs); anon reads nothing;
//   * the self-check aborts the WHOLE file on a missed REVOKE, a leftover
//     write policy, a table-level REVOKE that wipes mig 646's column grants,
//     another grantor's write (table and column level), an inherited write,
//     and 646's grants already gone; a second run passes; the plan's
//     rollback record restores the before-state exactly.
// Fictional ids and values only: the repo is public.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { SHIFT_COLUMN_GRANTS } from './helpers/shift-column-grants.js'

const read = (f) => readFileSync(path.resolve(import.meta.dirname, '../supabase/migrations', f), 'utf8')
const MIG_646 = read('646_shift_notes_column_grants.sql')
const MIG_676 = read('676_shift_tables_client_writes_off.sql')

// Mig 668's statements on the two shift tables, verbatim (section D).
const MIG_668_SHIFT_PART = `
REVOKE ALL ON public.shift_blocks, public.shift_assignments FROM anon, PUBLIC;
REVOKE TRUNCATE, REFERENCES, TRIGGER, MAINTAIN
  ON public.shift_blocks, public.shift_assignments FROM authenticated;
`

// The rollback record from the C82 plan (Task 5 Step 7), verbatim.
const ROLLBACK_676 = `
BEGIN;
SET LOCAL lock_timeout = '5s';
GRANT INSERT, UPDATE, DELETE ON public.shift_blocks, public.shift_assignments TO authenticated;
CREATE POLICY "shift_blocks_ins" ON public.shift_blocks FOR INSERT TO authenticated
  WITH CHECK (private.auth_is_master() OR private.auth_is_manager_at(location_id));
CREATE POLICY "shift_blocks_upd" ON public.shift_blocks FOR UPDATE TO authenticated
  USING (private.auth_is_master() OR private.auth_is_manager_at(location_id))
  WITH CHECK (private.auth_is_master() OR private.auth_is_manager_at(location_id));
CREATE POLICY "shift_blocks_del" ON public.shift_blocks FOR DELETE TO authenticated
  USING (private.auth_is_master() OR private.auth_is_manager_at(location_id));
CREATE POLICY "shift_assignments_ins" ON public.shift_assignments FOR INSERT TO authenticated
  WITH CHECK (private.auth_is_master() OR (EXISTS ( SELECT 1 FROM shift_blocks b WHERE b.id = shift_assignments.block_id AND private.auth_is_manager_at(b.location_id))));
CREATE POLICY "shift_assignments_upd" ON public.shift_assignments FOR UPDATE TO authenticated
  USING (private.auth_is_master() OR (EXISTS ( SELECT 1 FROM shift_blocks b WHERE b.id = shift_assignments.block_id AND private.auth_is_manager_at(b.location_id))))
  WITH CHECK (private.auth_is_master() OR (EXISTS ( SELECT 1 FROM shift_blocks b WHERE b.id = shift_assignments.block_id AND private.auth_is_manager_at(b.location_id))));
CREATE POLICY "shift_assignments_del" ON public.shift_assignments FOR DELETE TO authenticated
  USING (private.auth_is_master() OR (EXISTS ( SELECT 1 FROM shift_blocks b WHERE b.id = shift_assignments.block_id AND private.auth_is_manager_at(b.location_id))));
COMMIT;
`

const LOC_A = 'a0000000-0000-0000-0000-00000000000a'
const LOC_B = 'b0000000-0000-0000-0000-00000000000b'
const COACH = '10000000-0000-0000-0000-000000000001'     // staff at A
const HEAD = '10000000-0000-0000-0000-000000000003'      // head_coach at A (manager-tier in RLS)
const OWNER = '10000000-0000-0000-0000-000000000005'     // owner at A
const MASTER = '10000000-0000-0000-0000-000000000004'
const OUTSIDER = '10000000-0000-0000-0000-000000000006'  // staff at B only
const MANAGER = '10000000-0000-0000-0000-000000000007'   // manager at A
const ROSTER = '20000000-0000-0000-0000-000000000001'    // published, A
const TEMPLATE = '30000000-0000-0000-0000-000000000001'
const BLOCK = '40000000-0000-0000-0000-000000000001'     // published roster
const DRAFT_BLOCK = '40000000-0000-0000-0000-000000000002' // no roster: managers only
const OWN = '50000000-0000-0000-0000-000000000001'       // COACH on BLOCK
const HEADS = '50000000-0000-0000-0000-000000000002'     // HEAD on BLOCK
const DRAFT_ASG = '50000000-0000-0000-0000-000000000003' // COACH on DRAFT_BLOCK
const MGRS = '50000000-0000-0000-0000-000000000004'      // MANAGER on BLOCK
const NEW_ASG = '50000000-0000-0000-0000-000000000009'

const denied = (t) => new RegExp(`permission denied for (table|relation) ${t}\\b`)

const BASE_SCHEMA = `
  CREATE ROLE anon NOLOGIN;
  CREATE ROLE authenticated NOLOGIN;
  CREATE ROLE service_role NOLOGIN BYPASSRLS;
  CREATE ROLE other_grantor NOLOGIN;
  CREATE ROLE sneaky NOLOGIN;
  CREATE SCHEMA auth;
  CREATE SCHEMA private;
  GRANT USAGE ON SCHEMA auth, public TO anon, authenticated, service_role;
  GRANT USAGE ON SCHEMA private TO authenticated, service_role;   -- live: anon has none

  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;

  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
    SELECT nullif(current_setting('request.jwt.claims', true)::json->>'sub', '')::uuid
  $$;
  GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;

  CREATE TABLE public.locations (id uuid PRIMARY KEY, name text);
  CREATE TABLE public.profiles (id uuid PRIMARY KEY, role text NOT NULL, full_name text,
                                active boolean DEFAULT true, deleted_at timestamptz);
  CREATE TABLE public.profile_locations (profile_id uuid REFERENCES public.profiles(id),
    location_id uuid REFERENCES public.locations(id), role text NOT NULL, PRIMARY KEY (profile_id, location_id));
  REVOKE SELECT ON public.profiles FROM anon, authenticated;   -- mig 153b
  CREATE TABLE public.rosters (id uuid PRIMARY KEY, location_id uuid NOT NULL, status text NOT NULL);
  CREATE TABLE public.shift_templates (id uuid PRIMARY KEY, location_id uuid, name text, start_time time, end_time time);

  -- The two shift tables in PROD column order (pg_attribute, 30 Sep 2026).
  CREATE TABLE public.shift_blocks (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
    template_id uuid NOT NULL REFERENCES public.shift_templates(id) ON DELETE RESTRICT, block_date date NOT NULL,
    start_time time NOT NULL, end_time time NOT NULL, max_coaches smallint NOT NULL DEFAULT 1,
    roster_id uuid REFERENCES public.rosters(id) ON DELETE SET NULL, notes text,
    created_by uuid REFERENCES public.profiles(id),
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
    min_coaches smallint NOT NULL DEFAULT 1, briefing text
  );
  CREATE TABLE public.shift_assignments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    block_id uuid NOT NULL REFERENCES public.shift_blocks(id) ON DELETE CASCADE,
    profile_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE, notes text,
    status text NOT NULL DEFAULT 'scheduled', assigned_by uuid REFERENCES public.profiles(id),
    assigned_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
    start_time_override time, end_time_override time, partial_reason text,
    arrived_at timestamptz, arrival_source text
  );

  -- update_updated_at (INVOKER; EXECUTE postgres + service_role since mig 667).
  -- A trigger function's EXECUTE is not checked when it fires.
  CREATE FUNCTION public.update_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN NEW.updated_at = now(); RETURN NEW; END $$;
  REVOKE EXECUTE ON FUNCTION public.update_updated_at() FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION public.update_updated_at() TO service_role;
  CREATE TRIGGER set_shift_blocks_updated_at BEFORE UPDATE ON public.shift_blocks
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
  CREATE TRIGGER set_shift_assignments_updated_at BEFORE UPDATE ON public.shift_assignments
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

  -- Helpers, verbatim from prod (pg_get_functiondef, 30 Sep).
  CREATE FUNCTION private.auth_is_master() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
    SELECT EXISTS (SELECT 1 FROM public.profiles WHERE id = (SELECT auth.uid()) AND role = 'master'
                   AND active IS NOT FALSE AND deleted_at IS NULL)
  $$;
  CREATE FUNCTION private.auth_is_in_location(loc_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
    SELECT loc_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.profiles p WHERE p.id = (SELECT auth.uid()) AND p.active IS NOT FALSE AND p.deleted_at IS NULL
        AND (p.role = 'master' OR EXISTS (SELECT 1 FROM public.profile_locations
               WHERE profile_id = (SELECT auth.uid()) AND location_id = loc_id)))
  $$;
  CREATE FUNCTION private.auth_is_manager_at(p_location_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
    SELECT EXISTS (
      SELECT 1 FROM public.profiles p WHERE p.id = (SELECT auth.uid()) AND p.active IS NOT FALSE AND p.deleted_at IS NULL
        AND (p.role = 'master' OR EXISTS (SELECT 1 FROM public.profile_locations pl
               WHERE pl.profile_id = (SELECT auth.uid()) AND pl.location_id = p_location_id
                 AND pl.role IN ('owner','manager','head_coach'))))
  $$;
  CREATE FUNCTION private.auth_can_read_shift_block(p_location_id uuid, p_roster_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
    SELECT private.auth_is_manager_at(p_location_id)
    OR (private.auth_is_in_location(p_location_id)
        AND EXISTS (SELECT 1 FROM public.rosters r WHERE r.id = p_roster_id AND r.status = 'published'))
  $$;
  CREATE FUNCTION private.auth_can_read_shift_assignment(p_block_id uuid, p_profile_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
    SELECT EXISTS (
      SELECT 1 FROM public.shift_blocks b WHERE b.id = p_block_id
        AND (private.auth_is_manager_at(b.location_id)
             OR (EXISTS (SELECT 1 FROM public.rosters r WHERE r.id = b.roster_id AND r.status = 'published')
                 AND (private.auth_is_in_location(b.location_id) OR p_profile_id = (SELECT auth.uid())))))
  $$;
  GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA private TO authenticated, service_role;

  ALTER TABLE public.shift_blocks ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.shift_assignments ENABLE ROW LEVEL SECURITY;
`

// All eight live policies (mig 320's text for the six write policies, mig
// 614's for the two SELECT policies); PROD_TEXT below pins what they deparse to.
const PROD_POLICIES = `
  CREATE POLICY "shift_blocks_select" ON public.shift_blocks FOR SELECT TO authenticated
    USING (private.auth_can_read_shift_block(location_id, roster_id));
  CREATE POLICY "shift_assignments_select" ON public.shift_assignments FOR SELECT TO authenticated
    USING (private.auth_can_read_shift_assignment(block_id, profile_id));
` + ROLLBACK_676.replace(/^\s*(BEGIN|COMMIT|SET LOCAL lock_timeout = '5s');\s*$/gm, '')
  .replace('GRANT INSERT, UPDATE, DELETE ON public.shift_blocks, public.shift_assignments TO authenticated;', '')

// pg_policies on prod, 30 Sep 2026 (qual / with_check exactly as deparsed).
const SA_WRITE = '(private.auth_is_master() OR (EXISTS ( SELECT 1\n   FROM shift_blocks b\n  WHERE ((b.id = shift_assignments.block_id) AND private.auth_is_manager_at(b.location_id)))))'
const SB_WRITE = '(private.auth_is_master() OR private.auth_is_manager_at(location_id))'
const PROD_TEXT = [
  { tablename: 'shift_assignments', policyname: 'shift_assignments_del', cmd: 'DELETE', qual: SA_WRITE, with_check: null },
  { tablename: 'shift_assignments', policyname: 'shift_assignments_ins', cmd: 'INSERT', qual: null, with_check: SA_WRITE },
  { tablename: 'shift_assignments', policyname: 'shift_assignments_select', cmd: 'SELECT', qual: 'private.auth_can_read_shift_assignment(block_id, profile_id)', with_check: null },
  { tablename: 'shift_assignments', policyname: 'shift_assignments_upd', cmd: 'UPDATE', qual: SA_WRITE, with_check: SA_WRITE },
  { tablename: 'shift_blocks', policyname: 'shift_blocks_del', cmd: 'DELETE', qual: SB_WRITE, with_check: null },
  { tablename: 'shift_blocks', policyname: 'shift_blocks_ins', cmd: 'INSERT', qual: null, with_check: SB_WRITE },
  { tablename: 'shift_blocks', policyname: 'shift_blocks_select', cmd: 'SELECT', qual: 'private.auth_can_read_shift_block(location_id, roster_id)', with_check: null },
  { tablename: 'shift_blocks', policyname: 'shift_blocks_upd', cmd: 'UPDATE', qual: SB_WRITE, with_check: SB_WRITE },
]

const SEED = `
  INSERT INTO public.locations VALUES ('${LOC_A}', 'Studio A'), ('${LOC_B}', 'Studio B');
  INSERT INTO public.profiles (id, role, full_name) VALUES
    ('${COACH}', 'staff', 'Coach One'), ('${HEAD}', 'staff', 'Head Coach A'),
    ('${OWNER}', 'staff', 'Owner A'), ('${MASTER}', 'master', 'Master'), ('${OUTSIDER}', 'staff', 'Coach B'),
    ('${MANAGER}', 'staff', 'Manager A');
  INSERT INTO public.profile_locations VALUES
    ('${COACH}', '${LOC_A}', 'staff'), ('${HEAD}', '${LOC_A}', 'head_coach'),
    ('${OWNER}', '${LOC_A}', 'owner'), ('${OUTSIDER}', '${LOC_B}', 'staff'),
    ('${MANAGER}', '${LOC_A}', 'manager');
  INSERT INTO public.rosters VALUES ('${ROSTER}', '${LOC_A}', 'published');
  INSERT INTO public.shift_templates VALUES ('${TEMPLATE}', '${LOC_A}', 'AM', '09:00', '10:00');
  INSERT INTO public.shift_blocks (id, location_id, template_id, block_date, start_time, end_time, roster_id, notes, briefing) VALUES
    ('${BLOCK}', '${LOC_A}', '${TEMPLATE}', '2026-10-05', '09:00', '10:00', '${ROSTER}', 'BLOCK-NOTE: fictional', 'BRIEFING: fictional'),
    ('${DRAFT_BLOCK}', '${LOC_A}', '${TEMPLATE}', '2026-10-06', '09:00', '10:00', NULL, NULL, NULL);
  INSERT INTO public.shift_assignments (id, block_id, profile_id, partial_reason) VALUES
    ('${OWN}', '${BLOCK}', '${COACH}', NULL), ('${HEADS}', '${BLOCK}', '${HEAD}', 'PARTIAL: fictional'),
    ('${DRAFT_ASG}', '${DRAFT_BLOCK}', '${COACH}', NULL), ('${MGRS}', '${BLOCK}', '${MANAGER}', NULL);
`

// The phone's Today read (shared/dashboard-data.js fetchDashboardShifts), as
// PostgREST emits it: granted columns, the shift_blocks!inner embed and its
// date filter.
const PHONE_TODAY_SQL = `
  SELECT a.id, a.profile_id, a.start_time_override, a.end_time_override, a.status,
         (SELECT row_to_json(x.*) FROM (
            SELECT b.id, b.block_date::text AS block_date, b.start_time, b.end_time, b.briefing, b.location_id, b.roster_id
              FROM public.shift_blocks b WHERE b.id = a.block_id) x) AS shift_blocks
    FROM public.shift_assignments a
   WHERE a.profile_id = $1
     AND EXISTS (SELECT 1 FROM public.shift_blocks b WHERE b.id = a.block_id
                   AND b.block_date >= '2026-10-01' AND b.block_date <= '2026-10-31')
   ORDER BY a.id`
// The own-swaps list's nested embed: shift_assignments (id) -> shift_blocks.
const SWAP_EMBED_SQL = `
  SELECT a.id, (SELECT row_to_json(y.*) FROM (
            SELECT b.block_date::text AS block_date, b.start_time, b.end_time FROM public.shift_blocks b WHERE b.id = a.block_id) y) AS shift_blocks
    FROM public.shift_assignments a WHERE a.id = $1`

// The head coach's writes that the routes would refuse or wrap.
const FORGE_OWN_SQL = `
  UPDATE public.shift_assignments
     SET end_time_override = '12:00', arrived_at = '2026-10-05T07:00:00Z', arrival_source = 'geofence'
   WHERE id = '${HEADS}' RETURNING id`
const PLACE_OUTSIDER_SQL = `
  INSERT INTO public.shift_assignments (id, block_id, profile_id) VALUES ('${NEW_ASG}', '${BLOCK}', '${OUTSIDER}') RETURNING id`
const DELETE_BLOCK_SQL = `DELETE FROM public.shift_blocks WHERE id = '${BLOCK}' RETURNING id`

let db
// PGlite's multi-statement SQL runner (PGlite#exec — a SQL call, no shell).
const runSql = (text) => db.exec(text)

/** Run `sql` as `role` (with a JWT for `uid`) inside a rolled-back tx; returns rows. */
async function as(role, uid, sql, params = []) {
  await runSql('BEGIN')
  try {
    if (uid) await db.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: uid, role })])
    await runSql(`SET LOCAL ROLE ${role}`)
    return (await db.query(sql, params)).rows
  } finally {
    await runSql('ROLLBACK')
  }
}
const asUser = (uid, sql, params) => as('authenticated', uid, sql, params)
const asAnon = (sql) => as('anon', null, sql)
const asService = (sql) => as('service_role', null, sql)

const TABLES = ['shift_blocks', 'shift_assignments']
// [name, profile, their own assignment]: who reads the phone's Today tab.
const PHONE_READERS = [['head coach', HEAD, HEADS], ['coach', COACH, OWN], ['manager', MANAGER, MGRS]]
const PRIVS = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN']
const holds = async (role, table, priv) =>
  (await db.query(`SELECT has_table_privilege($1, $2, $3) AS v`, [role, `public.${table}`, priv])).rows[0].v
const holdsAnyColumn = async (role, table, priv) =>
  (await db.query(`SELECT has_any_column_privilege($1, $2, $3) AS v`, [role, `public.${table}`, priv])).rows[0].v

async function grantedColumns(table, grantee) {
  const { rows } = await db.query(
    `SELECT column_name FROM information_schema.column_privileges
      WHERE table_schema='public' AND table_name=$1 AND grantee=$2 AND privilege_type='SELECT'
      ORDER BY column_name`, [table, grantee])
  return rows.map((r) => r.column_name)
}

async function policies(table) {
  const { rows } = await db.query(
    `SELECT tablename::text, policyname::text, cmd, qual, with_check FROM pg_policies
      WHERE schemaname='public' AND tablename=$1 ORDER BY policyname`, [table])
  return rows
}

/** Every column's attacl, verbatim text: what "byte-identical" means. */
async function columnAcls() {
  const { rows } = await db.query(`
    SELECT a.attrelid::regclass::text AS t, a.attname::text AS col, a.attacl::text AS acl
      FROM pg_attribute a
     WHERE a.attrelid IN ('public.shift_blocks'::regclass, 'public.shift_assignments'::regclass)
       AND a.attnum > 0 AND NOT a.attisdropped
     ORDER BY 1, 2`)
  return rows
}

/** Every table and column ACL entry on the two tables, grantor included, order-free. */
async function aclSnapshot() {
  const { rows } = await db.query(`
    SELECT c.relname::text AS t, ''::text AS col,
           CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END AS grantee,
           a.grantor::regrole::text AS grantor, a.privilege_type AS priv, a.is_grantable AS g
      FROM pg_class c, aclexplode(c.relacl) a
     WHERE c.relnamespace = 'public'::regnamespace AND c.relname = ANY($1)
    UNION ALL
    SELECT c.relname::text, att.attname::text,
           CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END,
           a.grantor::regrole::text, a.privilege_type, a.is_grantable
      FROM pg_class c JOIN pg_attribute att ON att.attrelid = c.oid, aclexplode(att.attacl) a
     WHERE c.relnamespace = 'public'::regnamespace AND c.relname = ANY($1)
     ORDER BY 1, 2, 3, 4, 5`, [TABLES])
  return rows
}

async function boot({ migrate = false } = {}) {
  db = new PGlite()
  await runSql(BASE_SCHEMA)
  await runSql(PROD_POLICIES)
  await runSql(SEED)
  await runSql(MIG_646)              // applied on prod 28 Sep
  await runSql(MIG_668_SHIFT_PART)   // applied on prod 30 Sep
  if (migrate) await runSql(MIG_676)
}

describe('before 676: the replay is prod, and the hole is real (guards against a vacuous pass)', () => {
  beforeAll(() => boot(), 60_000)
  afterAll(() => db?.close())

  it("the eight policies deparse to prod's pg_policies text exactly", async () => {
    const got = [...await policies('shift_assignments'), ...await policies('shift_blocks')]
    expect(got).toEqual(PROD_TEXT)
  })

  it('the grants are prod: authenticated=awd + 646 column SELECT, anon and PUBLIC nothing', async () => {
    for (const t of TABLES) {
      for (const p of PRIVS) {
        expect(await holds('authenticated', t, p), `authenticated ${p} ${t}`).toBe(['INSERT', 'UPDATE', 'DELETE'].includes(p))
        expect(await holds('anon', t, p), `anon ${p} ${t}`).toBe(false)
      }
      expect(await grantedColumns(t, 'authenticated')).toEqual([...SHIFT_COLUMN_GRANTS[t].granted].sort())
    }
  })

  it('a head coach rewrites their OWN paid window and forges an arrival stamp with a bare UPDATE', async () => {
    expect(await asUser(HEAD, FORGE_OWN_SQL)).toEqual([{ id: HEADS }])
  })

  it('a head coach puts a person from another studio on a shift (no membership check)', async () => {
    expect(await asUser(HEAD, PLACE_OUTSIDER_SQL)).toEqual([{ id: NEW_ASG }])
  })

  it('a head coach deletes a published block; its assignments cascade away', async () => {
    await runSql('BEGIN')
    try {
      await db.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: HEAD, role: 'authenticated' })])
      await runSql('SET LOCAL ROLE authenticated')
      expect((await db.query(DELETE_BLOCK_SQL)).rows).toEqual([{ id: BLOCK }])
      await runSql('RESET ROLE')
      expect((await db.query(`SELECT count(*)::int AS n FROM public.shift_assignments WHERE block_id = '${BLOCK}'`)).rows).toEqual([{ n: 0 }])
    } finally {
      await runSql('ROLLBACK')
    }
  })

  it('a plain coach holds the write privilege; only the policy stops them', async () => {
    expect(await holds('authenticated', 'shift_assignments', 'UPDATE')).toBe(true)
    expect(await asUser(COACH, `UPDATE public.shift_assignments SET end_time_override = '12:00' WHERE id = '${OWN}' RETURNING id`)).toEqual([])
  })
})

describe('after 676', () => {
  let before
  beforeAll(async () => {
    await boot()
    before = {
      acls: await columnAcls(),
      selects: await Promise.all(TABLES.map(async (t) => (await policies(t)).filter((p) => p.cmd === 'SELECT'))),
      today: await asUser(COACH, PHONE_TODAY_SQL, [COACH]),
      swap: await asUser(COACH, SWAP_EMBED_SQL, [OWN]),
      phone: {},
      managerBlocks: await asUser(HEAD, `SELECT id FROM public.shift_blocks ORDER BY id`),
      coachBlocks: await asUser(COACH, `SELECT id FROM public.shift_blocks ORDER BY id`),
      coachAssignments: await asUser(COACH, `SELECT id FROM public.shift_assignments ORDER BY id`),
    }
    // One PGlite session: each read's BEGIN/ROLLBACK must not interleave.
    for (const [name, uid, asg] of PHONE_READERS) {
      before.phone[name] = { today: await asUser(uid, PHONE_TODAY_SQL, [uid]), swap: await asUser(uid, SWAP_EMBED_SQL, [asg]) }
    }
    await runSql(MIG_676)
  }, 60_000)
  afterAll(() => db?.close())

  describe('the catalog', () => {
    it.each(TABLES)('%s: no client role holds any table-level privilege', async (t) => {
      for (const role of ['anon', 'authenticated', 'public']) {
        for (const p of PRIVS) expect(await holds(role, t, p), `${role} ${p} ${t}`).toBe(false)
      }
    })

    it.each(TABLES)("%s: authenticated holds column SELECT only, exactly mig 646's list", async (t) => {
      expect(await grantedColumns(t, 'authenticated')).toEqual([...SHIFT_COLUMN_GRANTS[t].granted].sort())
      for (const p of ['INSERT', 'UPDATE', 'REFERENCES']) expect(await holdsAnyColumn('authenticated', t, p), `${p} ${t}`).toBe(false)
      for (const role of ['anon', 'public']) {
        for (const p of ['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) expect(await holdsAnyColumn(role, t, p), `${role} ${p} ${t}`).toBe(false)
      }
    })

    it('every column ACL is byte-identical to before', async () => {
      expect(before.acls.filter((r) => r.acl)).toHaveLength(15)
      expect(await columnAcls()).toEqual(before.acls)
    })

    it('one policy per table: its SELECT policy, unchanged', async () => {
      expect(await Promise.all(TABLES.map(policies))).toEqual(before.selects)
      expect(before.selects.map((s) => s.length)).toEqual([1, 1])
    })

    it('service_role keeps everything', async () => {
      for (const t of TABLES) for (const p of PRIVS) expect(await holds('service_role', t, p)).toBe(true)
    })
  })

  describe('no signed-in role writes either table', () => {
    it.each([['head coach', HEAD], ['owner', OWNER], ['manager', MANAGER], ['master', MASTER], ['coach', COACH]])('%s is refused INSERT, UPDATE and DELETE', async (_, uid) => {
      await expect(asUser(uid, FORGE_OWN_SQL)).rejects.toThrow(denied('shift_assignments'))
      await expect(asUser(uid, PLACE_OUTSIDER_SQL)).rejects.toThrow(denied('shift_assignments'))
      await expect(asUser(uid, `DELETE FROM public.shift_assignments WHERE id = '${OWN}'`)).rejects.toThrow(denied('shift_assignments'))
      await expect(asUser(uid, DELETE_BLOCK_SQL)).rejects.toThrow(denied('shift_blocks'))
      await expect(asUser(uid, `UPDATE public.shift_blocks SET roster_id = '${ROSTER}' WHERE id = '${DRAFT_BLOCK}'`)).rejects.toThrow(denied('shift_blocks'))
      await expect(asUser(uid, `INSERT INTO public.shift_blocks (location_id, template_id, block_date, start_time, end_time)
                                VALUES ('${LOC_A}', '${TEMPLATE}', '2026-10-07', '09:00', '10:00')`)).rejects.toThrow(denied('shift_blocks'))
    })

    it('nobody signed in may LOCK (MAINTAIN) or TRUNCATE them', async () => {
      await expect(asUser(MASTER, `LOCK TABLE public.shift_blocks IN ACCESS EXCLUSIVE MODE`)).rejects.toThrow(denied('shift_blocks'))
      await expect(asUser(MASTER, `TRUNCATE public.shift_assignments`)).rejects.toThrow(denied('shift_assignments'))
    })

    it('anon reads and writes nothing', async () => {
      for (const t of TABLES) await expect(asAnon(`SELECT id FROM public.${t}`)).rejects.toThrow(denied(t))
      await expect(asAnon(PLACE_OUTSIDER_SQL)).rejects.toThrow(denied('shift_assignments'))
    })
  })

  describe('reads are unchanged', () => {
    it("the phone's Today read returns the same rows (granted columns, block embed)", async () => {
      const today = await asUser(COACH, PHONE_TODAY_SQL, [COACH])
      expect(today).toEqual(before.today)
      expect(today.map((r) => r.id)).toEqual([OWN])   // the draft block's assignment stays hidden from a coach
      expect(today[0].shift_blocks).toMatchObject({ id: BLOCK, block_date: '2026-10-05', briefing: 'BRIEFING: fictional' })
    })

    it('the own-swaps nested embed returns the same row', async () => {
      expect(await asUser(COACH, SWAP_EMBED_SQL, [OWN])).toEqual(before.swap)
    })

    // Both phone reads as each signed-in tier that uses the phone's Today tab
    // (the head coach and the manager pass the manager-tier read rules, the
    // coach the published-roster one): non-empty before, identical after.
    it.each(PHONE_READERS)("%s: the phone's Today read and own-swaps embed are unchanged", async (name, uid, asg) => {
      const was = before.phone[name]
      expect(was.today.map((r) => r.id)).toContain(asg)
      expect(was.swap).toEqual([{ id: asg, shift_blocks: { block_date: '2026-10-05', start_time: '09:00:00', end_time: '10:00:00' } }])
      expect(await asUser(uid, PHONE_TODAY_SQL, [uid])).toEqual(was.today)
      expect(await asUser(uid, SWAP_EMBED_SQL, [asg])).toEqual(was.swap)
    })

    it('the SELECT policies admit the same rows (manager sees the draft block, the coach does not)', async () => {
      expect(await asUser(HEAD, `SELECT id FROM public.shift_blocks ORDER BY id`)).toEqual(before.managerBlocks)
      expect(before.managerBlocks.map((r) => r.id)).toEqual([BLOCK, DRAFT_BLOCK])
      expect(await asUser(COACH, `SELECT id FROM public.shift_blocks ORDER BY id`)).toEqual(before.coachBlocks)
      expect(await asUser(COACH, `SELECT id FROM public.shift_assignments ORDER BY id`)).toEqual(before.coachAssignments)
    })

    it('withheld columns stay refused', async () => {
      await expect(asUser(HEAD, `SELECT notes FROM public.shift_blocks`)).rejects.toThrow(denied('shift_blocks'))
      await expect(asUser(COACH, `SELECT partial_reason FROM public.shift_assignments`)).rejects.toThrow(denied('shift_assignments'))
    })
  })

  describe('the service role still does every write (every /api/schedule route)', () => {
    it('inserts a block and an assignment', async () => {
      await runSql('BEGIN')
      try {
        await runSql('SET LOCAL ROLE service_role')
        const b = (await db.query(`INSERT INTO public.shift_blocks (location_id, template_id, block_date, start_time, end_time)
                                   VALUES ('${LOC_A}', '${TEMPLATE}', '2026-10-07', '09:00', '10:00') RETURNING id`)).rows[0].id
        expect((await db.query(`INSERT INTO public.shift_assignments (block_id, profile_id) VALUES ($1, '${COACH}') RETURNING profile_id`, [b])).rows)
          .toEqual([{ profile_id: COACH }])
      } finally {
        await runSql('ROLLBACK')
      }
    })

    it('updates an assignment and the updated_at trigger fires', async () => {
      const rows = await asService(`UPDATE public.shift_assignments SET end_time_override = '09:45', updated_at = '2000-01-01'
                                     WHERE id = '${OWN}' RETURNING (updated_at > '2020-01-01') AS moved`)
      expect(rows).toEqual([{ moved: true }])
    })

    it('deletes a block and its assignments cascade', async () => {
      await runSql('BEGIN')
      try {
        await runSql('SET LOCAL ROLE service_role')
        expect((await db.query(DELETE_BLOCK_SQL)).rows).toEqual([{ id: BLOCK }])
        expect((await db.query(`SELECT count(*)::int AS n FROM public.shift_assignments WHERE block_id = '${BLOCK}'`)).rows).toEqual([{ n: 0 }])
      } finally {
        await runSql('ROLLBACK')
      }
    })
  })

  it('is idempotent: a second run passes its own self-check', async () => {
    await expect(runSql(MIG_676)).resolves.toBeDefined()
    expect(await columnAcls()).toEqual(before.acls)
  })
})

describe('the self-check aborts the WHOLE file', () => {
  // The file is one transaction, so a RAISE leaves it aborted; ROLLBACK then
  // restores the pre-676 state for the next case.
  beforeAll(() => boot(), 60_000)
  afterAll(() => db?.close())

  const stillOpen = async () => {
    expect(await holds('authenticated', 'shift_assignments', 'UPDATE')).toBe(true)
    expect(await policies('shift_blocks')).toHaveLength(4)
    expect(await grantedColumns('shift_blocks', 'authenticated')).toEqual([...SHIFT_COLUMN_GRANTS.shift_blocks.granted].sort())
  }
  const mutate = (from, to) => {
    const broken = MIG_676.replace(from, to)
    expect(broken).not.toBe(MIG_676)
    return broken
  }

  it('when the write REVOKE is missing', async () => {
    const broken = mutate('REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN\n  ON public.shift_blocks, public.shift_assignments FROM authenticated;\n', '')
    await expect(runSql(broken)).rejects.toThrow(/mig 676: authenticated still holds INSERT on public\.shift_blocks/)
    await runSql('ROLLBACK')
    await stillOpen()
  })

  it('when a write policy is left behind', async () => {
    const broken = mutate('DROP POLICY IF EXISTS shift_assignments_upd ON public.shift_assignments;\n', '')
    await expect(runSql(broken)).rejects.toThrow(/mig 676: public\.shift_assignments should keep exactly its unchanged SELECT policy, has: shift_assignments_select SELECT, shift_assignments_upd UPDATE/)
    await runSql('ROLLBACK')
    await stillOpen()
  })

  it("when a table-level REVOKE ALL from authenticated wipes mig 646's column grants", async () => {
    const broken = mutate('REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN\n  ON public.shift_blocks',
      'REVOKE ALL\n  ON public.shift_blocks')
    await expect(runSql(broken)).rejects.toThrow(/mig 676: granted column shift_blocks\.id is no longer readable by authenticated/)
    await runSql('ROLLBACK')
    await stillOpen()
  })

  it("when another grantor's table-level UPDATE survives the owner's REVOKE", async () => {
    await runSql(`BEGIN;
      GRANT UPDATE ON public.shift_assignments TO other_grantor WITH GRANT OPTION;
      SET ROLE other_grantor;
      GRANT UPDATE ON public.shift_assignments TO authenticated;
      RESET ROLE;`)
    await expect(runSql(MIG_676)).rejects.toThrow(/mig 676: authenticated still holds UPDATE on public\.shift_assignments/)
    await runSql('ROLLBACK')
    await stillOpen()
  })

  it("when another grantor's COLUMN-level UPDATE survives", async () => {
    await runSql(`BEGIN;
      GRANT UPDATE (arrived_at) ON public.shift_assignments TO other_grantor WITH GRANT OPTION;
      SET ROLE other_grantor;
      GRANT UPDATE (arrived_at) ON public.shift_assignments TO authenticated;
      RESET ROLE;`)
    await expect(runSql(MIG_676)).rejects.toThrow(/mig 676: authenticated still holds column-level UPDATE on public\.shift_assignments/)
    await runSql('ROLLBACK')
    await stillOpen()
  })

  it('when authenticated inherits a write through another role', async () => {
    await runSql(`BEGIN;
      GRANT DELETE ON public.shift_blocks TO sneaky;
      GRANT sneaky TO authenticated;`)
    await expect(runSql(MIG_676)).rejects.toThrow(/mig 676: authenticated still holds DELETE on public\.shift_blocks/)
    await runSql('ROLLBACK')
    await stillOpen()
  })

  // Last in this block: before the fix the file COMMITs here.
  it("when mig 646's column grants are already gone (an empty before-list proves nothing)", async () => {
    await runSql(`BEGIN;
      REVOKE SELECT ON public.shift_blocks FROM authenticated;`)
    await expect(runSql(MIG_676)).rejects.toThrow(/mig 676: mig 646's column grants are missing before this file ran \(found 7 column ACLs, expected 15\)/)
    await runSql('ROLLBACK')
    await stillOpen()
  })
})

describe("the plan's rollback record restores the before-state exactly", () => {
  beforeAll(() => boot(), 60_000)
  afterAll(() => db?.close())

  it('ACLs (table and column, grantor included), column ACL text and policies', async () => {
    const aclBefore = await aclSnapshot()
    const colBefore = await columnAcls()
    const polBefore = await Promise.all(TABLES.map(policies))
    await runSql(MIG_676)
    expect(await aclSnapshot()).not.toEqual(aclBefore)
    await runSql(ROLLBACK_676)
    expect(await aclSnapshot()).toEqual(aclBefore)
    expect(await columnAcls()).toEqual(colBefore)
    expect(await Promise.all(TABLES.map(policies))).toEqual(polBefore)
  })
})
