// GRANTSWEEP.1 — behavioural GRANT test for migration 668.
//
// No local Supabase stack exists, so a grant change otherwise gets its first
// execution on prod. This boots PGlite (PostgreSQL 17) with Supabase's
// DEFAULT PRIVILEGES (ALL on every new public table for anon, authenticated
// and service_role), the five scheduling tables in PROD column order with
// their CHECKs (30 Sep 2026), the prod policies and helpers verbatim, the
// prod grant history that matters (mig 153b on profiles, migs 624/625 on
// time_off_requests, and the REAL mig 646 file on the shift tables), then:
//
//   * BEFORE: a plain coach reads colleagues' and non-staff door/geofence
//     events with their payload; inserts a swap for a COLLEAGUE's shift,
//     already 'awaiting_approval', from their own session; a head coach
//     approves a swap with a bare UPDATE; anon holds writes and TRUNCATE;
//   * AFTER: staff_attendance_events refuses every client (masters too);
//     swaps and leave are read-only for authenticated (writes and LOCK, i.e.
//     MAINTAIN, refused); anon reads nothing on the five; the phone's two
//     reads and the SELECT policies' row sets are unchanged; mig 646's
//     column grants and the managers' shift writes are unchanged; the
//     service role reads and writes everything;
//   * the self-check aborts the WHOLE file on a missed REVOKE, a leftover
//     write policy, another grantor's write, an inherited write and a
//     table-level REVOKE that would wipe mig 646's column grants; a second
//     run passes; the plan's rollback record restores the before-state.
// Fictional ids and values only: the repo is public.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import {
  ANON_NONE_TABLES, CLIENT_ROLES, TABLE_PRIVILEGES, EXPECTED_TABLE_PRIVILEGES,
} from './helpers/scheduling-client-grants.js'
import { SHIFT_COLUMN_GRANTS } from './helpers/shift-column-grants.js'

const read = (f) => readFileSync(path.resolve(import.meta.dirname, '../supabase/migrations', f), 'utf8')
const MIG_646 = read('646_shift_notes_column_grants.sql')
const MIG_668 = read('668_scheduling_tables_client_grants.sql')

// The rollback record from the C15 plan (Task 5 Step 6), verbatim.
const ROLLBACK_668 = `
BEGIN;
SET LOCAL lock_timeout = '5s';
GRANT ALL ON public.staff_attendance_events TO anon, authenticated;
CREATE POLICY "Staff read attendance at their locations" ON public.staff_attendance_events
  FOR SELECT TO public
  USING (private.auth_is_master() OR private.auth_is_in_location(location_id));
GRANT ALL ON public.shift_swap_requests TO anon, authenticated;
CREATE POLICY shift_swap_requests_insert ON public.shift_swap_requests FOR INSERT TO authenticated
  WITH CHECK (private.auth_is_manager_at(location_id)
              OR ((requester_id = (SELECT auth.uid())) AND private.auth_is_in_location(location_id)));
CREATE POLICY shift_swap_requests_update ON public.shift_swap_requests FOR UPDATE TO authenticated
  USING (private.auth_is_manager_at(location_id))
  WITH CHECK (private.auth_is_manager_at(location_id));
CREATE POLICY shift_swap_requests_delete ON public.shift_swap_requests FOR DELETE TO authenticated
  USING (private.auth_is_manager_at(location_id));
GRANT SELECT, MAINTAIN ON public.time_off_requests TO anon;
GRANT MAINTAIN ON public.time_off_requests TO authenticated;
GRANT INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN
  ON public.shift_blocks, public.shift_assignments TO anon;
GRANT TRUNCATE, REFERENCES, TRIGGER, MAINTAIN
  ON public.shift_blocks, public.shift_assignments TO authenticated;
COMMIT;
`

const LOC_A = 'a0000000-0000-0000-0000-00000000000a'
const LOC_B = 'b0000000-0000-0000-0000-00000000000b'
const COACH = '10000000-0000-0000-0000-000000000001'      // staff at A
const COLLEAGUE = '10000000-0000-0000-0000-000000000002'  // staff at A
const HEAD = '10000000-0000-0000-0000-000000000003'       // head_coach at A (manager-tier in RLS)
const MASTER = '10000000-0000-0000-0000-000000000004'
const ROSTER = '20000000-0000-0000-0000-000000000001'
const TEMPLATE = '30000000-0000-0000-0000-000000000001'
const BLOCK = '40000000-0000-0000-0000-000000000001'
const OWN = '50000000-0000-0000-0000-000000000001'
const MATE = '50000000-0000-0000-0000-000000000002'
const SWAP_OWN = '60000000-0000-0000-0000-000000000001'
const SWAP_FORGED = '60000000-0000-0000-0000-000000000009'
const LEAVE_OWN = '70000000-0000-0000-0000-000000000001'
const LEAVE_MATE = '70000000-0000-0000-0000-000000000002'
const EV_OWN = '80000000-0000-0000-0000-000000000001'
const EV_MATE = '80000000-0000-0000-0000-000000000002'
const EV_UNKNOWN = '80000000-0000-0000-0000-000000000003'

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

  -- The two shift tables in prod column order (mig 646's self-check needs every column).
  CREATE TABLE public.shift_blocks (
    id uuid PRIMARY KEY, location_id uuid NOT NULL REFERENCES public.locations(id),
    template_id uuid NOT NULL REFERENCES public.shift_templates(id), block_date date NOT NULL,
    start_time time NOT NULL, end_time time NOT NULL, max_coaches smallint NOT NULL DEFAULT 1,
    roster_id uuid REFERENCES public.rosters(id), notes text, created_by uuid,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
    min_coaches smallint NOT NULL DEFAULT 1, briefing text
  );
  CREATE TABLE public.shift_assignments (
    id uuid PRIMARY KEY, block_id uuid NOT NULL REFERENCES public.shift_blocks(id),
    profile_id uuid NOT NULL REFERENCES public.profiles(id), notes text,
    status text NOT NULL DEFAULT 'scheduled', assigned_by uuid,
    assigned_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
    start_time_override time, end_time_override time, partial_reason text,
    arrived_at timestamptz, arrival_source text
  );

  -- The three tables: PROD column order, defaults, keys and CHECKs (pg_attribute/pg_constraint, 30 Sep 2026).
  CREATE TABLE public.shift_swap_requests (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
    requester_shift_id uuid REFERENCES public.shift_assignments(id) ON DELETE SET NULL,
    requester_id uuid NOT NULL REFERENCES public.profiles(id),
    target_shift_id uuid REFERENCES public.shift_assignments(id) ON DELETE SET NULL,
    target_id uuid REFERENCES public.profiles(id),
    reason text,
    status text DEFAULT 'pending' CHECK (status = ANY (ARRAY['pending','awaiting_approval','approved','rejected','cancelled'])),
    reviewed_by uuid REFERENCES public.profiles(id),
    reviewed_at timestamptz,
    review_note text,
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now()
  );
  CREATE TABLE public.time_off_requests (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    profile_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    location_id uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
    type text NOT NULL CHECK (type = ANY (ARRAY['holiday','sick','unpaid','other','unavailable'])),
    start_date date NOT NULL,
    end_date date NOT NULL,
    total_days numeric(5,1) NOT NULL DEFAULT 1,
    reason text,
    status text NOT NULL DEFAULT 'pending' CHECK (status = ANY (ARRAY['pending','approved','rejected','cancelled'])),
    reviewed_by uuid REFERENCES public.profiles(id),
    reviewed_at timestamptz,
    review_note text,
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now(),
    created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    cancel_requested_at timestamptz,
    cancel_requested_by uuid REFERENCES public.profiles(id),
    cancel_request_note text,
    cancel_decided_at timestamptz,
    cancel_decided_by uuid REFERENCES public.profiles(id),
    cancel_decision text CHECK (cancel_decision = ANY (ARRAY['approved','rejected'])),
    cancel_decision_note text,
    CONSTRAINT valid_date_range CHECK (end_date >= start_date)
  );
  CREATE TABLE public.staff_attendance_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    profile_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    location_id uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
    source text NOT NULL CHECK (source = ANY (ARRAY['unifi_access','protect','manual','geofence'])),
    unifi_user_id text,
    unifi_door_id text,
    event_at timestamptz NOT NULL,
    received_at timestamptz NOT NULL DEFAULT now(),
    matched_assignment_id uuid REFERENCES public.shift_assignments(id) ON DELETE SET NULL,
    match_outcome text NOT NULL CHECK (match_outcome = ANY (ARRAY['matched','no_shift_in_window','already_stamped','unknown_user','wrong_location'])),
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
  );

  -- Prod grant history on time_off_requests: mig 624 revoked UPDATE, mig 625
  -- the rest of the writes (relacl anon=rm, authenticated=rm on 30 Sep).
  REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.time_off_requests FROM anon, authenticated, PUBLIC;

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
  ALTER TABLE public.shift_swap_requests ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.time_off_requests ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.staff_attendance_events ENABLE ROW LEVEL SECURITY;
`

// The live policies (pg_policies, 30 Sep 2026; the shift tables' INSERT and
// DELETE policies are left out: nothing here exercises them).
const PROD_POLICIES = `
  CREATE POLICY "shift_blocks_select" ON public.shift_blocks FOR SELECT TO authenticated
    USING (private.auth_can_read_shift_block(location_id, roster_id));
  CREATE POLICY "shift_blocks_upd" ON public.shift_blocks FOR UPDATE TO authenticated
    USING (private.auth_is_master() OR private.auth_is_manager_at(location_id))
    WITH CHECK (private.auth_is_master() OR private.auth_is_manager_at(location_id));
  CREATE POLICY "shift_assignments_select" ON public.shift_assignments FOR SELECT TO authenticated
    USING (private.auth_can_read_shift_assignment(block_id, profile_id));

  CREATE POLICY shift_swap_requests_select ON public.shift_swap_requests FOR SELECT TO authenticated
    USING (private.auth_is_manager_at(location_id) OR (requester_id = (SELECT auth.uid())) OR (target_id = (SELECT auth.uid())));
  CREATE POLICY shift_swap_requests_insert ON public.shift_swap_requests FOR INSERT TO authenticated
    WITH CHECK (private.auth_is_manager_at(location_id)
                OR ((requester_id = (SELECT auth.uid())) AND private.auth_is_in_location(location_id)));
  CREATE POLICY shift_swap_requests_update ON public.shift_swap_requests FOR UPDATE TO authenticated
    USING (private.auth_is_manager_at(location_id))
    WITH CHECK (private.auth_is_manager_at(location_id));
  CREATE POLICY shift_swap_requests_delete ON public.shift_swap_requests FOR DELETE TO authenticated
    USING (private.auth_is_manager_at(location_id));

  CREATE POLICY time_off_requests_select ON public.time_off_requests FOR SELECT TO authenticated
    USING ((profile_id = (SELECT auth.uid())) OR private.auth_is_manager_at(location_id));

  CREATE POLICY "Staff read attendance at their locations" ON public.staff_attendance_events
    FOR SELECT TO public
    USING (private.auth_is_master() OR private.auth_is_in_location(location_id));
`

const SEED = `
  INSERT INTO public.locations VALUES ('${LOC_A}', 'Studio A'), ('${LOC_B}', 'Studio B');
  INSERT INTO public.profiles (id, role, full_name) VALUES
    ('${COACH}', 'staff', 'Coach One'), ('${COLLEAGUE}', 'staff', 'Coach Two'),
    ('${HEAD}', 'staff', 'Head Coach A'), ('${MASTER}', 'master', 'Master');
  INSERT INTO public.profile_locations VALUES
    ('${COACH}', '${LOC_A}', 'staff'), ('${COLLEAGUE}', '${LOC_A}', 'staff'), ('${HEAD}', '${LOC_A}', 'head_coach');
  INSERT INTO public.rosters VALUES ('${ROSTER}', '${LOC_A}', 'published');
  INSERT INTO public.shift_templates VALUES ('${TEMPLATE}', '${LOC_A}', 'AM', '09:00', '10:00');
  INSERT INTO public.shift_blocks (id, location_id, template_id, block_date, start_time, end_time, roster_id)
    VALUES ('${BLOCK}', '${LOC_A}', '${TEMPLATE}', '2026-10-05', '09:00', '10:00', '${ROSTER}');
  INSERT INTO public.shift_assignments (id, block_id, profile_id) VALUES
    ('${OWN}', '${BLOCK}', '${COACH}'), ('${MATE}', '${BLOCK}', '${COLLEAGUE}');
  INSERT INTO public.shift_swap_requests (id, location_id, requester_shift_id, requester_id, target_id, reason, status)
    VALUES ('${SWAP_OWN}', '${LOC_A}', '${OWN}', '${COACH}', '${COLLEAGUE}', 'SWAP-REASON: fictional', 'pending');
  INSERT INTO public.time_off_requests (id, profile_id, location_id, type, start_date, end_date, reason, status) VALUES
    ('${LEAVE_OWN}', '${COACH}', '${LOC_A}', 'holiday', '2026-11-02', '2026-11-03', 'LEAVE-REASON: own', 'pending'),
    ('${LEAVE_MATE}', '${COLLEAGUE}', '${LOC_A}', 'sick', '2026-10-01', '2026-10-01', 'LEAVE-REASON: colleague', 'approved');
  INSERT INTO public.staff_attendance_events (id, profile_id, location_id, source, event_at, match_outcome, payload) VALUES
    ('${EV_OWN}', '${COACH}', '${LOC_A}', 'geofence', '2026-10-05T07:55:00Z', 'matched', '{"device_name":"DEVICE-OWN"}'),
    ('${EV_MATE}', '${COLLEAGUE}', '${LOC_A}', 'geofence', '2026-10-04T19:10:00Z', 'no_shift_in_window', '{"device_name":"DEVICE-MATE"}'),
    ('${EV_UNKNOWN}', NULL, '${LOC_A}', 'unifi_access', '2026-10-04T21:00:00Z', 'unknown_user', '{"raw":{"actor":"NOT-STAFF"}}');
`

// The phone's two direct reads (shared/dashboard-data.js fetchPersonalDashboardData),
// as PostgREST emits them.
const PHONE_SWAPS_SQL = `
  SELECT s.id, s.status, s.reason, s.created_at, s.target_id, s.requester_shift_id,
         (SELECT row_to_json(x.*) FROM (
            SELECT (SELECT row_to_json(y.*) FROM (
                      SELECT b.block_date, b.start_time, b.end_time,
                             (SELECT row_to_json(z.*) FROM (SELECT t.name FROM public.shift_templates t WHERE t.id = b.template_id) z) AS shift_templates
                        FROM public.shift_blocks b WHERE b.id = a.block_id) y) AS shift_blocks
              FROM public.shift_assignments a WHERE a.id = s.requester_shift_id) x) AS requester_shift
    FROM public.shift_swap_requests s
   WHERE s.requester_id = $1 AND s.status IN ('pending', 'awaiting_approval')`
const PHONE_LEAVE_SQL = `
  SELECT id, type, start_date, end_date, status, created_at FROM public.time_off_requests
   WHERE profile_id = $1 AND status = 'pending' ORDER BY start_date`

const FORGED_SWAP_SQL = `
  INSERT INTO public.shift_swap_requests (id, location_id, requester_shift_id, requester_id, target_id, status)
  VALUES ('${SWAP_FORGED}', '${LOC_A}', '${MATE}', '${COACH}', '${COACH}', 'awaiting_approval') RETURNING id`

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

const holds = async (role, table, priv) =>
  (await db.query(`SELECT has_table_privilege($1, $2, $3) AS v`, [role, `public.${table}`, priv])).rows[0].v

async function grantedColumns(table, grantee) {
  const { rows } = await db.query(
    `SELECT column_name FROM information_schema.column_privileges
      WHERE table_schema='public' AND table_name=$1 AND grantee=$2 AND privilege_type='SELECT'
      ORDER BY column_name`, [table, grantee])
  return rows.map((r) => r.column_name)
}

async function policies(table) {
  const { rows } = await db.query(
    `SELECT policyname, cmd, roles::text, qual, with_check FROM pg_policies
      WHERE schemaname='public' AND tablename=$1 ORDER BY policyname`, [table])
  return rows
}

/** Every table and column ACL entry on the five tables, grantor included, order-free. */
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
     ORDER BY 1, 2, 3, 4, 5`, [ANON_NONE_TABLES])
  return rows
}

async function boot({ migrate = false } = {}) {
  db = new PGlite()
  await runSql(BASE_SCHEMA)
  await runSql(PROD_POLICIES)
  await runSql(SEED)
  await runSql(MIG_646)          // prod has 646 applied (28 Sep)
  if (migrate) await runSql(MIG_668)
}

describe('before 668: the gaps are real (guards against a vacuous pass)', () => {
  beforeAll(() => boot(), 60_000)
  afterAll(() => db?.close())

  it("a plain coach reads colleagues' and non-staff door/geofence events, payload included", async () => {
    const rows = await asUser(COACH, `
      SELECT id, payload FROM public.staff_attendance_events
       WHERE profile_id IS DISTINCT FROM (SELECT auth.uid()) ORDER BY id`)
    expect(rows.map((r) => r.id)).toEqual([EV_MATE, EV_UNKNOWN])
    expect(JSON.stringify(rows)).toContain('DEVICE-MATE')
    expect(JSON.stringify(rows)).toContain('NOT-STAFF')
  })

  it("a plain coach inserts a swap for a COLLEAGUE's shift, already awaiting approval", async () => {
    expect(await asUser(COACH, FORGED_SWAP_SQL)).toEqual([{ id: SWAP_FORGED }])
  })

  it('a head coach approves a swap with a bare UPDATE (no RPC, no shift move, no notice)', async () => {
    const rows = await asUser(HEAD, `UPDATE public.shift_swap_requests SET status = 'approved' WHERE id = '${SWAP_OWN}' RETURNING id`)
    expect(rows).toEqual([{ id: SWAP_OWN }])
  })

  it('anon holds writes and TRUNCATE; authenticated holds MAINTAIN on time off', async () => {
    expect(await holds('anon', 'shift_swap_requests', 'INSERT')).toBe(true)
    expect(await holds('anon', 'staff_attendance_events', 'TRUNCATE')).toBe(true)
    expect(await holds('anon', 'shift_blocks', 'UPDATE')).toBe(true)
    expect(await holds('authenticated', 'time_off_requests', 'MAINTAIN')).toBe(true)
  })
})

describe('after 668', () => {
  beforeAll(() => boot({ migrate: true }), 60_000)
  afterAll(() => db?.close())

  describe('the catalog', () => {
    it.each(ANON_NONE_TABLES)('%s: every client role holds exactly the promised table privileges', async (table) => {
      for (const role of CLIENT_ROLES) {
        const want = EXPECTED_TABLE_PRIVILEGES[role][table]
        for (const priv of TABLE_PRIVILEGES) {
          expect(await holds(role, table, priv), `${role} ${priv} ${table}`).toBe(want.includes(priv))
        }
      }
    })

    it('anon and PUBLIC hold no column privilege; authenticated none on attendance events', async () => {
      for (const table of ANON_NONE_TABLES) {
        for (const role of ['anon', 'public']) {
          for (const priv of ['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) {
            const { rows } = await db.query(`SELECT has_any_column_privilege($1, $2, $3) AS v`, [role, `public.${table}`, priv])
            expect(rows[0].v, `${role} ${priv} ${table}`).toBe(false)
          }
        }
      }
      const { rows } = await db.query(`SELECT has_any_column_privilege('authenticated', 'public.staff_attendance_events', 'SELECT') AS v`)
      expect(rows[0].v).toBe(false)
    })

    it("mig 646's column grants are exactly as they were", async () => {
      for (const [table, { granted }] of Object.entries(SHIFT_COLUMN_GRANTS)) {
        expect(await grantedColumns(table, 'authenticated')).toEqual([...granted].sort())
      }
    })

    it('policies: none on attendance events, only the untouched SELECT policy on swaps and leave', async () => {
      expect(await policies('staff_attendance_events')).toEqual([])
      expect((await policies('shift_swap_requests')).map((p) => `${p.policyname} ${p.cmd}`)).toEqual(['shift_swap_requests_select SELECT'])
      expect((await policies('time_off_requests')).map((p) => `${p.policyname} ${p.cmd}`)).toEqual(['time_off_requests_select SELECT'])
    })
  })

  describe('staff_attendance_events is service-role only', () => {
    it.each([['coach', COACH], ['head coach', HEAD], ['master', MASTER]])('%s cannot read it at all', async (_, uid) => {
      await expect(asUser(uid, `SELECT id FROM public.staff_attendance_events`)).rejects.toThrow(denied('staff_attendance_events'))
      await expect(asUser(uid, `SELECT count(*) FROM public.staff_attendance_events`)).rejects.toThrow(denied('staff_attendance_events'))
    })

    it('anon cannot read it', async () => {
      await expect(asAnon(`SELECT id FROM public.staff_attendance_events`)).rejects.toThrow(denied('staff_attendance_events'))
    })

    it('the service role still reads and writes it (the door webhook, the geofence check-in, the report)', async () => {
      expect(await asService(`SELECT count(*)::int AS n FROM public.staff_attendance_events`)).toEqual([{ n: 3 }])
      const ins = await asService(`INSERT INTO public.staff_attendance_events (location_id, source, event_at, match_outcome)
                                   VALUES ('${LOC_A}', 'geofence', now(), 'no_shift_in_window') RETURNING location_id`)
      expect(ins).toEqual([{ location_id: LOC_A }])
    })
  })

  describe('swaps and leave are read-only for a client session', () => {
    it("a coach can no longer forge a swap for a colleague's shift", async () => {
      await expect(asUser(COACH, FORGED_SWAP_SQL)).rejects.toThrow(denied('shift_swap_requests'))
    })

    it('a head coach and master can no longer UPDATE or DELETE a swap directly', async () => {
      for (const uid of [HEAD, MASTER]) {
        await expect(asUser(uid, `UPDATE public.shift_swap_requests SET status = 'approved' WHERE id = '${SWAP_OWN}'`))
          .rejects.toThrow(denied('shift_swap_requests'))
        await expect(asUser(uid, `DELETE FROM public.shift_swap_requests WHERE id = '${SWAP_OWN}'`))
          .rejects.toThrow(denied('shift_swap_requests'))
      }
    })

    it('no client can write leave or take a MAINTAIN lock on it', async () => {
      await expect(asUser(COACH, `INSERT INTO public.time_off_requests (profile_id, location_id, type, start_date, end_date, status)
                                  VALUES ('${COACH}', '${LOC_A}', 'holiday', '2026-12-01', '2026-12-01', 'approved')`))
        .rejects.toThrow(denied('time_off_requests'))
      await expect(asUser(HEAD, `LOCK TABLE public.time_off_requests IN ACCESS EXCLUSIVE MODE`)).rejects.toThrow(denied('time_off_requests'))
    })

    it('the phone reads the same rows: its own swaps (with reason) and its own pending leave', async () => {
      const swaps = await asUser(COACH, PHONE_SWAPS_SQL, [COACH])
      expect(swaps).toHaveLength(1)
      expect(swaps[0]).toMatchObject({ id: SWAP_OWN, status: 'pending', reason: 'SWAP-REASON: fictional', target_id: COLLEAGUE })
      expect(swaps[0].requester_shift.shift_blocks).toMatchObject({ block_date: '2026-10-05', shift_templates: { name: 'AM' } })
      const leave = await asUser(COACH, PHONE_LEAVE_SQL, [COACH])
      expect(leave.map((r) => r.id)).toEqual([LEAVE_OWN])
    })

    it('the SELECT policies admit the same rows as before (the swap target, the studio manager)', async () => {
      expect(await asUser(COLLEAGUE, `SELECT id, reason FROM public.shift_swap_requests`)).toEqual([{ id: SWAP_OWN, reason: 'SWAP-REASON: fictional' }])
      expect((await asUser(HEAD, `SELECT id FROM public.time_off_requests ORDER BY id`)).map((r) => r.id)).toEqual([LEAVE_OWN, LEAVE_MATE])
      expect((await asUser(COACH, `SELECT id FROM public.time_off_requests`)).map((r) => r.id)).toEqual([LEAVE_OWN])
    })

    it('anon reads none of the five', async () => {
      for (const t of ANON_NONE_TABLES) await expect(asAnon(`SELECT id FROM public.${t}`)).rejects.toThrow(denied(t))
    })

    it('the service role still updates and deletes swaps and leave (every /api/schedule route)', async () => {
      expect(await asService(`UPDATE public.shift_swap_requests SET status = 'cancelled' WHERE id = '${SWAP_OWN}' RETURNING id`)).toEqual([{ id: SWAP_OWN }])
      expect(await asService(`UPDATE public.time_off_requests SET status = 'approved' WHERE id = '${LEAVE_OWN}' RETURNING id`)).toEqual([{ id: LEAVE_OWN }])
      expect(await asService(`DELETE FROM public.shift_swap_requests WHERE id = '${SWAP_OWN}' RETURNING id`)).toEqual([{ id: SWAP_OWN }])
    })
  })

  describe('the shift tables (mig 646) keep their reads and manager writes', () => {
    it("a coach still reads granted block columns (the phone's embed)", async () => {
      expect(await asUser(COACH, `SELECT id, block_date::text AS block_date FROM public.shift_blocks`)).toEqual([{ id: BLOCK, block_date: '2026-10-05' }])
    })

    it('a head coach may still UPDATE a block at their studio (write grant + policy, unchanged)', async () => {
      expect(await asUser(HEAD, `UPDATE public.shift_blocks SET start_time = '08:30' WHERE id = '${BLOCK}' RETURNING id`)).toEqual([{ id: BLOCK }])
    })

    it('nobody signed in may TRUNCATE a shift table any more', async () => {
      await expect(asUser(MASTER, `TRUNCATE public.shift_assignments CASCADE`)).rejects.toThrow(/permission denied for (table|relation) shift_/)
    })
  })

  it('is idempotent: a second run passes its own self-check', async () => {
    await expect(runSql(MIG_668)).resolves.toBeDefined()
  })
})

describe('the self-check aborts the WHOLE file', () => {
  // The file is one transaction, so a RAISE leaves it aborted; ROLLBACK then
  // restores the pre-668 state for the next case.
  beforeAll(() => boot(), 60_000)
  afterAll(() => db?.close())

  const stillOpen = async () => {
    expect(await holds('anon', 'shift_swap_requests', 'INSERT')).toBe(true)
    expect(await policies('staff_attendance_events')).toHaveLength(1)
  }

  it('when the attendance REVOKE is missing', async () => {
    const broken = MIG_668.replace('REVOKE ALL ON public.staff_attendance_events FROM anon, authenticated, PUBLIC;\n', '')
    expect(broken).not.toBe(MIG_668)
    await expect(runSql(broken)).rejects.toThrow(/still holds SELECT on public\.staff_attendance_events/)
    await runSql('ROLLBACK')
    await stillOpen()
  })

  it('when a swap write policy is left behind', async () => {
    const broken = MIG_668.replace('DROP POLICY IF EXISTS shift_swap_requests_insert ON public.shift_swap_requests;\n', '')
    expect(broken).not.toBe(MIG_668)
    await expect(runSql(broken)).rejects.toThrow(/public\.shift_swap_requests should keep exactly one policy/)
    await runSql('ROLLBACK')
    await stillOpen()
  })

  it("when another grantor's INSERT survives the owner's REVOKE", async () => {
    await runSql(`BEGIN;
      GRANT INSERT ON public.shift_swap_requests TO other_grantor WITH GRANT OPTION;
      SET ROLE other_grantor;
      GRANT INSERT ON public.shift_swap_requests TO authenticated;
      RESET ROLE;`)
    await expect(runSql(MIG_668)).rejects.toThrow(/authenticated still holds INSERT on public\.shift_swap_requests/)
    await runSql('ROLLBACK')
    await stillOpen()
  })

  it('when authenticated inherits a write through another role', async () => {
    await runSql(`BEGIN;
      GRANT INSERT ON public.time_off_requests TO sneaky;
      GRANT sneaky TO authenticated;`)
    await expect(runSql(MIG_668)).rejects.toThrow(/authenticated still holds INSERT on public\.time_off_requests/)
    await runSql('ROLLBACK')
    await stillOpen()
  })

  it("when a table-level REVOKE would wipe mig 646's column grants", async () => {
    const broken = MIG_668.replace(
      'REVOKE TRUNCATE, REFERENCES, TRIGGER, MAINTAIN\n  ON public.shift_blocks, public.shift_assignments FROM authenticated;',
      'REVOKE ALL ON public.shift_blocks, public.shift_assignments FROM authenticated;',
    )
    expect(broken).not.toBe(MIG_668)
    await expect(runSql(broken)).rejects.toThrow(/mig 646's authenticated column SELECT list changed/)
    await runSql('ROLLBACK')
    expect(await grantedColumns('shift_blocks', 'authenticated')).toEqual([...SHIFT_COLUMN_GRANTS.shift_blocks.granted].sort())
  })
})

describe("the plan's rollback record restores the before-state exactly", () => {
  beforeAll(() => boot(), 60_000)
  afterAll(() => db?.close())

  it('ACLs (table and column, grantor included) and policies', async () => {
    const three = ['staff_attendance_events', 'shift_swap_requests', 'time_off_requests']
    const aclBefore = await aclSnapshot()
    const polBefore = await Promise.all(three.map(policies))
    await runSql(MIG_668)
    expect(await aclSnapshot()).not.toEqual(aclBefore)
    await runSql(ROLLBACK_668)
    expect(await aclSnapshot()).toEqual(aclBefore)
    expect(await Promise.all(three.map(policies))).toEqual(polBefore)
  })
})
