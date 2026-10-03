// ROSTERCLIENTWRITE.1 — behavioural GRANT test for migration 679.
//
// No local Supabase stack exists, so a grant change otherwise gets its first
// execution on prod. This boots PGlite (PostgreSQL 17) with Supabase's
// DEFAULT PRIVILEGES (ALL on every new public table for anon, authenticated
// and service_role), rosters and shift_templates in PROD column order, the
// two shift tables the phone reads them through, the prod helpers and all
// eight roster/template policies verbatim (their deparsed text pinned
// against prod's pg_policies), the updated_at triggers with prod's EXECUTE,
// and the prod grant history: the REAL mig 618 file (rosters' column
// SELECT), the REAL mig 646 file, mig 668's shift statements verbatim and the
// REAL mig 676 file (prod state on 30 Sep: rosters anon=awdDxtm,
// authenticated=awdDxtm + 618's 5 column SELECTs; shift_templates anon and
// authenticated arwdDxtm). Then:
//
//   * BEFORE: a head coach approves an over-budget draft roster themselves
//     (a coach then sees its shifts), hides a published week from every coach
//     by superseding its roster, writes a budget figure they cannot read,
//     deletes and inserts rosters, and inserts, rewrites and deletes shift
//     templates, all with bare SQL from their own session; a plain coach
//     holds the privilege (the policy is the only fence);
//   * AFTER: no signed-in role (coach, head coach, manager, owner, master)
//     can INSERT, UPDATE or DELETE either table; every column ACL is
//     byte-identical and shift_templates keeps its table-level SELECT, so the
//     phone's Today read (rosters(status) and shift_templates(name, …)
//     embeds) and the own-swaps embed (shift_templates(name)) return the same
//     rows for a coach, a head coach and a manager; rosters' withheld columns
//     stay refused; the two SELECT policies are untouched; the service role
//     still approves (the trigger fires), publishes, deletes (blocks keep,
//     roster_id nulled) and edits templates; anon reads and writes nothing;
//   * the self-check aborts the WHOLE file on a missed REVOKE (authenticated
//     or anon), a leftover write policy, a table-level REVOKE that wipes mig
//     618's column grants, a lost shift_templates SELECT, another grantor's
//     write (table and column level), an inherited write, another grantor's
//     anon grant, a column ACL or a SELECT policy changed mid-file, and 618's
//     grants already gone; a second run passes; the plan's rollback record
//     restores the authenticated writes and policies exactly (and gives anon
//     nothing back).
// Fictional ids and values only: the repo is public.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const read = (f) => readFileSync(path.resolve(import.meta.dirname, '../supabase/migrations', f), 'utf8')
const MIG_618 = read('618_coach_budget_and_role_scope.sql')
const MIG_646 = read('646_shift_notes_column_grants.sql')
const MIG_676 = read('676_shift_tables_client_writes_off.sql')
const MIG_679 = read('679_rosters_shift_templates_client_writes_off.sql')

// Mig 668's statements on the two shift tables, verbatim (section D).
const MIG_668_SHIFT_PART = `
REVOKE ALL ON public.shift_blocks, public.shift_assignments FROM anon, PUBLIC;
REVOKE TRUNCATE, REFERENCES, TRIGGER, MAINTAIN
  ON public.shift_blocks, public.shift_assignments FROM authenticated;
`

// The rollback record from the C110 plan (Task 5 Step 7), verbatim.
const ROLLBACK_679 = `
BEGIN;
SET LOCAL lock_timeout = '5s';
GRANT INSERT, UPDATE, DELETE ON public.rosters, public.shift_templates TO authenticated;
CREATE POLICY "rosters_ins" ON public.rosters FOR INSERT TO authenticated
  WITH CHECK (private.auth_is_master() OR private.auth_is_manager_at(location_id));
CREATE POLICY "rosters_upd" ON public.rosters FOR UPDATE TO authenticated
  USING (private.auth_is_master() OR private.auth_is_manager_at(location_id))
  WITH CHECK (private.auth_is_master() OR private.auth_is_manager_at(location_id));
CREATE POLICY "rosters_del" ON public.rosters FOR DELETE TO authenticated
  USING (private.auth_is_master() OR private.auth_is_manager_at(location_id));
CREATE POLICY "shift_templates_ins" ON public.shift_templates FOR INSERT TO authenticated
  WITH CHECK (private.auth_is_manager_at(location_id));
CREATE POLICY "shift_templates_upd" ON public.shift_templates FOR UPDATE TO authenticated
  USING (private.auth_is_manager_at(location_id))
  WITH CHECK (private.auth_is_manager_at(location_id));
CREATE POLICY "shift_templates_del" ON public.shift_templates FOR DELETE TO authenticated
  USING (private.auth_is_manager_at(location_id));
COMMIT;
`

const LOC_A = 'a0000000-0000-0000-0000-00000000000a'
const LOC_B = 'b0000000-0000-0000-0000-00000000000b'
const COACH = '10000000-0000-0000-0000-000000000001'     // staff at A
const HEAD = '10000000-0000-0000-0000-000000000003'      // head_coach at A (manager-tier in RLS)
const MASTER = '10000000-0000-0000-0000-000000000004'
const OWNER = '10000000-0000-0000-0000-000000000005'     // owner at A
const MANAGER = '10000000-0000-0000-0000-000000000007'   // manager at A
const PUBLISHED = '20000000-0000-0000-0000-000000000001' // published, A, October
const DRAFT = '20000000-0000-0000-0000-000000000002'     // over-budget draft, A, November
const OLD = '20000000-0000-0000-0000-000000000003'       // superseded, A, September
const TEMPLATE = '30000000-0000-0000-0000-000000000001'  // A, used by both blocks
const SPARE = '30000000-0000-0000-0000-000000000002'     // A, used by no block
const TEMPLATE_B = '30000000-0000-0000-0000-000000000003'
const NEW_TEMPLATE = '30000000-0000-0000-0000-000000000009'
const BLOCK = '40000000-0000-0000-0000-000000000001'     // on PUBLISHED
const DRAFT_BLOCK = '40000000-0000-0000-0000-000000000002' // on DRAFT
const OWN = '50000000-0000-0000-0000-000000000001'       // COACH on BLOCK
const HEADS = '50000000-0000-0000-0000-000000000002'     // HEAD on BLOCK
const MGRS = '50000000-0000-0000-0000-000000000004'      // MANAGER on BLOCK
const DRAFT_ASG = '50000000-0000-0000-0000-000000000003' // COACH on DRAFT_BLOCK
const SWAP = '60000000-0000-0000-0000-000000000001'

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

  -- rosters and shift_templates in PROD column order (pg_attribute, 30 Sep 2026).
  CREATE TABLE public.rosters (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
    period_start date NOT NULL, period_end date NOT NULL,
    status text NOT NULL DEFAULT 'published' CHECK (status = ANY (ARRAY['draft', 'published', 'superseded'])),
    published_by uuid REFERENCES public.profiles(id), published_at timestamptz,
    over_budget_approval_by uuid REFERENCES public.profiles(id), over_budget_approval_at timestamptz,
    projected_contractor_eur numeric, budget_at_publish_eur numeric, notes text,
    created_by uuid REFERENCES public.profiles(id),
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
    superseded_by uuid REFERENCES public.rosters(id) ON DELETE SET NULL, superseded_at timestamptz,
    requested_period_start date, requested_period_end date,
    CHECK (period_end >= period_start)
  );
  CREATE TABLE public.shift_templates (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
    name text NOT NULL, start_time time NOT NULL, end_time time NOT NULL,
    color text DEFAULT '#3B82F6', role_label text, active boolean DEFAULT true,
    display_order integer DEFAULT 0, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
    days_of_week text[] NOT NULL DEFAULT '{}', max_coaches smallint NOT NULL DEFAULT 15,
    min_coaches smallint NOT NULL DEFAULT 1, kind text NOT NULL DEFAULT 'class',
    UNIQUE (location_id, name)
  );

  -- The two shift tables in PROD column order (as in the mig 676 replay).
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
  -- The own-swaps list reaches the template through this (mig 668: SELECT only).
  CREATE TABLE public.shift_swap_requests (id uuid PRIMARY KEY, requester_id uuid,
    requester_shift_id uuid REFERENCES public.shift_assignments(id) ON DELETE SET NULL, status text);
  REVOKE ALL ON public.shift_swap_requests FROM anon, authenticated;
  GRANT SELECT ON public.shift_swap_requests TO authenticated;

  -- What the REAL mig 618 file also touches (its strap_assignments half).
  CREATE TABLE public.ble_bridges (id uuid PRIMARY KEY, location_id uuid);
  CREATE TABLE public.strap_assignments (id uuid PRIMARY KEY, ble_bridge_id uuid, contact_id uuid);
  CREATE FUNCTION private.auth_contact_id() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;

  -- update_updated_at (INVOKER; EXECUTE postgres + service_role since mig 667).
  -- A trigger function's EXECUTE is not checked when it fires.
  CREATE FUNCTION public.update_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN NEW.updated_at = now(); RETURN NEW; END $$;
  REVOKE EXECUTE ON FUNCTION public.update_updated_at() FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION public.update_updated_at() TO service_role;
  CREATE TRIGGER set_rosters_updated_at BEFORE UPDATE ON public.rosters
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
  CREATE TRIGGER set_shift_templates_updated_at BEFORE UPDATE ON public.shift_templates
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

  ALTER TABLE public.rosters ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.shift_templates ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.shift_blocks ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.shift_assignments ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.shift_swap_requests ENABLE ROW LEVEL SECURITY;
  CREATE POLICY "own swaps" ON public.shift_swap_requests FOR SELECT TO authenticated
    USING (requester_id = (SELECT auth.uid()));
`

// The live policies: the two SELECT policies on rosters and shift_templates,
// the six write policies (built from the rollback record, so the rollback
// recreates exactly what prod has; PROD_TEXT pins both), and the two shift
// tables' SELECT policies (mig 614).
const PROD_POLICIES = `
  CREATE POLICY "rosters_select" ON public.rosters FOR SELECT TO authenticated
    USING (private.auth_is_manager_at(location_id)
           OR (private.auth_is_in_location(location_id) AND status = ANY (ARRAY['published', 'superseded'])));
  CREATE POLICY "shift_templates_select" ON public.shift_templates FOR SELECT TO authenticated
    USING (private.auth_is_in_location(location_id));
  CREATE POLICY "shift_blocks_select" ON public.shift_blocks FOR SELECT TO authenticated
    USING (private.auth_can_read_shift_block(location_id, roster_id));
  CREATE POLICY "shift_assignments_select" ON public.shift_assignments FOR SELECT TO authenticated
    USING (private.auth_can_read_shift_assignment(block_id, profile_id));
` + ROLLBACK_679.replace(/^\s*(BEGIN|COMMIT|SET LOCAL lock_timeout = '5s');\s*$/gm, '')
  .replace('GRANT INSERT, UPDATE, DELETE ON public.rosters, public.shift_templates TO authenticated;', '')

// pg_policies on prod, 30 Sep 2026 (qual / with_check exactly as deparsed).
const R_WRITE = '(private.auth_is_master() OR private.auth_is_manager_at(location_id))'
const T_WRITE = 'private.auth_is_manager_at(location_id)'
const R_READ = "(private.auth_is_manager_at(location_id) OR (private.auth_is_in_location(location_id) AND (status = ANY (ARRAY['published'::text, 'superseded'::text]))))"
const PROD_TEXT = [
  { tablename: 'rosters', policyname: 'rosters_del', cmd: 'DELETE', qual: R_WRITE, with_check: null },
  { tablename: 'rosters', policyname: 'rosters_ins', cmd: 'INSERT', qual: null, with_check: R_WRITE },
  { tablename: 'rosters', policyname: 'rosters_select', cmd: 'SELECT', qual: R_READ, with_check: null },
  { tablename: 'rosters', policyname: 'rosters_upd', cmd: 'UPDATE', qual: R_WRITE, with_check: R_WRITE },
  { tablename: 'shift_templates', policyname: 'shift_templates_del', cmd: 'DELETE', qual: T_WRITE, with_check: null },
  { tablename: 'shift_templates', policyname: 'shift_templates_ins', cmd: 'INSERT', qual: null, with_check: T_WRITE },
  { tablename: 'shift_templates', policyname: 'shift_templates_select', cmd: 'SELECT', qual: 'private.auth_is_in_location(location_id)', with_check: null },
  { tablename: 'shift_templates', policyname: 'shift_templates_upd', cmd: 'UPDATE', qual: T_WRITE, with_check: T_WRITE },
]

const SEED = `
  INSERT INTO public.locations VALUES ('${LOC_A}', 'Studio A'), ('${LOC_B}', 'Studio B');
  INSERT INTO public.profiles (id, role, full_name) VALUES
    ('${COACH}', 'staff', 'Coach One'), ('${HEAD}', 'staff', 'Head Coach A'), ('${MASTER}', 'master', 'Master'),
    ('${OWNER}', 'staff', 'Owner A'), ('${MANAGER}', 'staff', 'Manager A');
  INSERT INTO public.profile_locations VALUES
    ('${COACH}', '${LOC_A}', 'staff'), ('${HEAD}', '${LOC_A}', 'head_coach'),
    ('${OWNER}', '${LOC_A}', 'owner'), ('${MANAGER}', '${LOC_A}', 'manager');
  INSERT INTO public.rosters (id, location_id, period_start, period_end, status, projected_contractor_eur, budget_at_publish_eur, notes) VALUES
    ('${PUBLISHED}', '${LOC_A}', '2026-10-01', '2026-10-31', 'published', 100, 1000, 'NOTE: fictional'),
    ('${DRAFT}', '${LOC_A}', '2026-11-01', '2026-11-30', 'draft', 1500, 1000, NULL),
    ('${OLD}', '${LOC_A}', '2026-09-01', '2026-09-30', 'superseded', NULL, NULL, NULL);
  INSERT INTO public.shift_templates (id, location_id, name, start_time, end_time, days_of_week) VALUES
    ('${TEMPLATE}', '${LOC_A}', 'AM', '09:00', '10:00', '{mon}'),
    ('${SPARE}', '${LOC_A}', 'Spare', '12:00', '13:00', '{}'),
    ('${TEMPLATE_B}', '${LOC_B}', 'AM', '09:00', '10:00', '{mon}');
  INSERT INTO public.shift_blocks (id, location_id, template_id, block_date, start_time, end_time, roster_id, briefing) VALUES
    ('${BLOCK}', '${LOC_A}', '${TEMPLATE}', '2026-10-05', '09:00', '10:00', '${PUBLISHED}', 'BRIEFING: fictional'),
    ('${DRAFT_BLOCK}', '${LOC_A}', '${TEMPLATE}', '2026-11-02', '09:00', '10:00', '${DRAFT}', NULL);
  INSERT INTO public.shift_assignments (id, block_id, profile_id) VALUES
    ('${OWN}', '${BLOCK}', '${COACH}'), ('${HEADS}', '${BLOCK}', '${HEAD}'),
    ('${MGRS}', '${BLOCK}', '${MANAGER}'), ('${DRAFT_ASG}', '${DRAFT_BLOCK}', '${COACH}');
  INSERT INTO public.shift_swap_requests VALUES ('${SWAP}', '${COACH}', '${OWN}', 'pending');
`

// The phone's Today read (shared/dashboard-data.js fetchDashboardShifts), as
// PostgREST emits it: granted columns, the shift_blocks!inner embed with its
// rosters:roster_id(status) and shift_templates(name, start_time, end_time)
// embeds, and the date filter.
const PHONE_TODAY_SQL = `
  SELECT a.id, a.profile_id, a.start_time_override, a.end_time_override, a.status,
         (SELECT row_to_json(x.*) FROM (
            SELECT b.id, b.block_date::text AS block_date, b.start_time, b.end_time, b.briefing, b.location_id, b.roster_id,
                   (SELECT row_to_json(r.*) FROM (SELECT r.status FROM public.rosters r WHERE r.id = b.roster_id) r) AS rosters,
                   (SELECT row_to_json(t.*) FROM (SELECT t.name, t.start_time, t.end_time FROM public.shift_templates t WHERE t.id = b.template_id) t) AS shift_templates
              FROM public.shift_blocks b WHERE b.id = a.block_id) x) AS shift_blocks
    FROM public.shift_assignments a
   WHERE a.profile_id = $1
     AND EXISTS (SELECT 1 FROM public.shift_blocks b WHERE b.id = a.block_id
                   AND b.block_date >= '2026-09-01' AND b.block_date <= '2026-11-30')
   ORDER BY a.id`
// The own-swaps list: shift_swap_requests -> shift_assignments!requester_shift_id
// -> shift_blocks!block_id -> shift_templates(name).
const SWAP_EMBED_SQL = `
  SELECT s.id, s.status, (SELECT row_to_json(y.*) FROM (
            SELECT (SELECT row_to_json(z.*) FROM (
                      SELECT b.block_date::text AS block_date, b.start_time, b.end_time,
                             (SELECT row_to_json(t.*) FROM (SELECT t.name FROM public.shift_templates t WHERE t.id = b.template_id) t) AS shift_templates
                        FROM public.shift_blocks b WHERE b.id = a.block_id) z) AS shift_blocks
              FROM public.shift_assignments a WHERE a.id = s.requester_shift_id) y) AS requester_shift
    FROM public.shift_swap_requests s WHERE s.requester_id = $1 ORDER BY s.id`

// The head coach's writes that the routes refuse or wrap.
const APPROVE_OWN_SQL = `
  UPDATE public.rosters SET status = 'published', over_budget_approval_by = '${HEAD}', over_budget_approval_at = now()
   WHERE id = '${DRAFT}' RETURNING id`
const HIDE_WEEK_SQL = `UPDATE public.rosters SET status = 'superseded' WHERE id = '${PUBLISHED}' RETURNING id`
const BUDGET_SQL = `UPDATE public.rosters SET budget_at_publish_eur = 999999 WHERE id = '${DRAFT}'`
const DELETE_ROSTER_SQL = `DELETE FROM public.rosters WHERE id = '${OLD}' RETURNING id`
const INSERT_ROSTER_SQL = `INSERT INTO public.rosters (location_id, period_start, period_end, status)
  VALUES ('${LOC_A}', '2026-12-01', '2026-12-31', 'published') RETURNING id`
const INSERT_TEMPLATE_SQL = `INSERT INTO public.shift_templates (id, location_id, name, start_time, end_time)
  VALUES ('${NEW_TEMPLATE}', '${LOC_A}', 'Forged', '05:00', '23:00') RETURNING id`
const UPDATE_TEMPLATE_SQL = `UPDATE public.shift_templates SET start_time = '05:00', max_coaches = 50 WHERE id = '${TEMPLATE}' RETURNING id`
const DELETE_TEMPLATE_SQL = `DELETE FROM public.shift_templates WHERE id = '${SPARE}' RETURNING id`

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

/** As `writer`, run `write`; then, in the SAME rolled-back tx, run `check` as `reader`. */
async function writeThenRead(writer, write, reader, check, params = []) {
  await runSql('BEGIN')
  try {
    await db.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: writer, role: 'authenticated' })])
    await runSql('SET LOCAL ROLE authenticated')
    const wrote = (await db.query(write)).rows
    await db.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: reader, role: 'authenticated' })])
    return { wrote, rows: (await db.query(check, params)).rows }
  } finally {
    await runSql('ROLLBACK')
  }
}

const TABLES = ['rosters', 'shift_templates']
const ROSTER_GRANTED = ['id', 'location_id', 'period_end', 'period_start', 'status']
// [name, profile]: who reads the phone's Today tab and own-swaps list.
const PHONE_READERS = [['coach', COACH], ['head coach', HEAD], ['manager', MANAGER]]
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
     WHERE a.attrelid IN ('public.rosters'::regclass, 'public.shift_templates'::regclass)
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
  await runSql(MIG_618)              // applied on prod 17 Sep
  await runSql(MIG_646)              // applied on prod 28 Sep
  await runSql(MIG_668_SHIFT_PART)   // applied on prod 30 Sep
  await runSql(MIG_676)              // applied on prod 30 Sep
  if (migrate) await runSql(MIG_679)
}

describe('before 679: the replay is prod, and the hole is real (guards against a vacuous pass)', () => {
  beforeAll(() => boot(), 60_000)
  afterAll(() => db?.close())

  it("the eight policies deparse to prod's pg_policies text exactly", async () => {
    const got = [...await policies('rosters'), ...await policies('shift_templates')]
    expect(got).toEqual(PROD_TEXT)
  })

  it("the grants are prod: rosters awdDxtm + 618's 5 columns; shift_templates arwdDxtm; anon the same, no columns", async () => {
    for (const p of PRIVS) {
      expect(await holds('authenticated', 'rosters', p), `authenticated ${p} rosters`).toBe(p !== 'SELECT')
      expect(await holds('anon', 'rosters', p), `anon ${p} rosters`).toBe(p !== 'SELECT')
      expect(await holds('authenticated', 'shift_templates', p), `authenticated ${p} shift_templates`).toBe(true)
      expect(await holds('anon', 'shift_templates', p), `anon ${p} shift_templates`).toBe(true)
    }
    expect(await grantedColumns('rosters', 'authenticated')).toEqual(ROSTER_GRANTED)
    expect(await grantedColumns('rosters', 'anon')).toEqual([])
    expect((await columnAcls()).filter((r) => r.acl)).toHaveLength(5)
  })

  it('a head coach approves an over-budget draft themselves, and a coach then sees its shifts', async () => {
    expect(await asUser(COACH, `SELECT id FROM public.shift_blocks ORDER BY id`)).toEqual([{ id: BLOCK }])
    const { wrote, rows } = await writeThenRead(HEAD, APPROVE_OWN_SQL, COACH, `SELECT id FROM public.shift_blocks ORDER BY id`)
    expect(wrote).toEqual([{ id: DRAFT }])
    expect(rows).toEqual([{ id: BLOCK }, { id: DRAFT_BLOCK }])
  })

  it("a head coach hides a published week from every coach (the phone's Today read empties)", async () => {
    expect((await asUser(COACH, PHONE_TODAY_SQL, [COACH])).map((r) => r.id)).toEqual([OWN])
    const { wrote, rows } = await writeThenRead(HEAD, HIDE_WEEK_SQL, COACH, PHONE_TODAY_SQL, [COACH])
    expect(wrote).toEqual([{ id: PUBLISHED }])
    expect(rows).toEqual([])
  })

  it('a head coach writes a budget figure they may not read, deletes a roster and inserts a published one', async () => {
    await expect(asUser(HEAD, BUDGET_SQL)).resolves.toEqual([])
    await expect(asUser(HEAD, `SELECT budget_at_publish_eur FROM public.rosters`)).rejects.toThrow(denied('rosters'))
    expect(await asUser(HEAD, DELETE_ROSTER_SQL)).toEqual([{ id: OLD }])
    expect(await asUser(HEAD, INSERT_ROSTER_SQL)).toHaveLength(1)
  })

  it('a head coach inserts, rewrites and deletes shift templates', async () => {
    expect(await asUser(HEAD, INSERT_TEMPLATE_SQL)).toEqual([{ id: NEW_TEMPLATE }])
    expect(await asUser(HEAD, UPDATE_TEMPLATE_SQL)).toEqual([{ id: TEMPLATE }])
    expect(await asUser(HEAD, DELETE_TEMPLATE_SQL)).toEqual([{ id: SPARE }])
  })

  it('a plain coach holds the write privileges; only the policies stop them', async () => {
    expect(await holds('authenticated', 'rosters', 'UPDATE')).toBe(true)
    expect(await asUser(COACH, HIDE_WEEK_SQL)).toEqual([])
    expect(await asUser(COACH, UPDATE_TEMPLATE_SQL)).toEqual([])
  })
})

describe('after 679', () => {
  let before
  beforeAll(async () => {
    await boot()
    before = {
      acls: await columnAcls(),
      selects: await Promise.all(TABLES.map(async (t) => (await policies(t)).filter((p) => p.cmd === 'SELECT'))),
      phone: {},
      managerRosters: await asUser(MANAGER, `SELECT id, status FROM public.rosters ORDER BY id`),
      coachRosters: await asUser(COACH, `SELECT id, status FROM public.rosters ORDER BY id`),
      coachTemplates: await asUser(COACH, `SELECT * FROM public.shift_templates ORDER BY id`),
    }
    // One PGlite session: each read's BEGIN/ROLLBACK must not interleave.
    for (const [name, uid] of PHONE_READERS) {
      before.phone[name] = { today: await asUser(uid, PHONE_TODAY_SQL, [uid]), swaps: await asUser(uid, SWAP_EMBED_SQL, [uid]) }
    }
    await runSql(MIG_679)
  }, 60_000)
  afterAll(() => db?.close())

  describe('the catalog', () => {
    it('rosters: no client role holds any table-level privilege', async () => {
      for (const role of ['anon', 'authenticated', 'public']) {
        for (const p of PRIVS) expect(await holds(role, 'rosters', p), `${role} ${p}`).toBe(false)
      }
    })

    it('shift_templates: authenticated holds SELECT and nothing else; anon and PUBLIC nothing', async () => {
      for (const p of PRIVS) {
        expect(await holds('authenticated', 'shift_templates', p), `authenticated ${p}`).toBe(p === 'SELECT')
        expect(await holds('anon', 'shift_templates', p), `anon ${p}`).toBe(false)
        expect(await holds('public', 'shift_templates', p), `PUBLIC ${p}`).toBe(false)
      }
    })

    it.each(TABLES)('%s: no column-level write for any client role, no column privilege for anon/PUBLIC', async (t) => {
      for (const p of ['INSERT', 'UPDATE', 'REFERENCES']) expect(await holdsAnyColumn('authenticated', t, p), `${p} ${t}`).toBe(false)
      for (const role of ['anon', 'public']) {
        for (const p of ['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) expect(await holdsAnyColumn(role, t, p), `${role} ${p} ${t}`).toBe(false)
      }
    })

    it("rosters: authenticated reads exactly mig 618's five columns", async () => {
      expect(await grantedColumns('rosters', 'authenticated')).toEqual(ROSTER_GRANTED)
    })

    it('every column ACL is byte-identical to before', async () => {
      expect(before.acls.filter((r) => r.acl)).toHaveLength(5)
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
    it.each([['head coach', HEAD], ['manager', MANAGER], ['owner', OWNER], ['master', MASTER], ['coach', COACH]])('%s is refused INSERT, UPDATE and DELETE', async (_, uid) => {
      for (const sql of [APPROVE_OWN_SQL, HIDE_WEEK_SQL, BUDGET_SQL, DELETE_ROSTER_SQL, INSERT_ROSTER_SQL]) {
        await expect(asUser(uid, sql), sql).rejects.toThrow(denied('rosters'))
      }
      for (const sql of [INSERT_TEMPLATE_SQL, UPDATE_TEMPLATE_SQL, DELETE_TEMPLATE_SQL]) {
        await expect(asUser(uid, sql), sql).rejects.toThrow(denied('shift_templates'))
      }
    })

    it('nobody signed in may LOCK (MAINTAIN) or TRUNCATE them', async () => {
      await expect(asUser(MASTER, `LOCK TABLE public.rosters IN ACCESS EXCLUSIVE MODE`)).rejects.toThrow(denied('rosters'))
      await expect(asUser(MASTER, `TRUNCATE public.shift_templates`)).rejects.toThrow(denied('shift_templates'))
    })

    it('anon reads and writes nothing', async () => {
      for (const t of TABLES) await expect(asAnon(`SELECT id FROM public.${t}`)).rejects.toThrow(denied(t))
      await expect(asAnon(HIDE_WEEK_SQL)).rejects.toThrow(denied('rosters'))
      await expect(asAnon(INSERT_TEMPLATE_SQL)).rejects.toThrow(denied('shift_templates'))
    })
  })

  describe('reads are unchanged', () => {
    // Both phone reads as each signed-in tier that uses the phone: the coach
    // passes the published-roster rules, the head coach and the manager the
    // manager-tier ones. Non-empty before, identical after.
    it.each(PHONE_READERS)("%s: the phone's Today read (rosters and template embeds) and own-swaps list are unchanged", async (name, uid) => {
      const was = before.phone[name]
      expect(was.today.length).toBeGreaterThan(0)
      expect(was.today.find((r) => r.shift_blocks.id === BLOCK).shift_blocks).toMatchObject({
        rosters: { status: 'published' }, shift_templates: { name: 'AM', start_time: '09:00:00', end_time: '10:00:00' },
      })
      expect(await asUser(uid, PHONE_TODAY_SQL, [uid])).toEqual(was.today)
      expect(await asUser(uid, SWAP_EMBED_SQL, [uid])).toEqual(was.swaps)
    })

    it("the coach's own-swaps list still names the template", async () => {
      expect(before.phone.coach.swaps).toEqual([{ id: SWAP, status: 'pending', requester_shift: { shift_blocks: {
        block_date: '2026-10-05', start_time: '09:00:00', end_time: '10:00:00', shift_templates: { name: 'AM' } } } }])
    })

    it('the SELECT policies admit the same rows (a manager sees the draft, a coach does not)', async () => {
      expect(await asUser(MANAGER, `SELECT id, status FROM public.rosters ORDER BY id`)).toEqual(before.managerRosters)
      expect(before.managerRosters.map((r) => r.id)).toEqual([PUBLISHED, DRAFT, OLD])
      expect(await asUser(COACH, `SELECT id, status FROM public.rosters ORDER BY id`)).toEqual(before.coachRosters)
      expect(before.coachRosters.map((r) => r.id)).toEqual([PUBLISHED, OLD])
      expect(await asUser(COACH, `SELECT * FROM public.shift_templates ORDER BY id`)).toEqual(before.coachTemplates)
      expect(before.coachTemplates.map((r) => r.id)).toEqual([TEMPLATE, SPARE])
    })

    it("rosters' withheld columns stay refused", async () => {
      await expect(asUser(MANAGER, `SELECT budget_at_publish_eur FROM public.rosters`)).rejects.toThrow(denied('rosters'))
      await expect(asUser(COACH, `SELECT notes FROM public.rosters`)).rejects.toThrow(denied('rosters'))
      await expect(asUser(COACH, `SELECT * FROM public.rosters`)).rejects.toThrow(denied('rosters'))
    })
  })

  describe('the service role still does every write (every /api/schedule route)', () => {
    it('approves a draft (the approve route) and the updated_at trigger fires', async () => {
      const rows = await asService(`UPDATE public.rosters SET status = 'published', over_budget_approval_by = '${OWNER}',
                                      over_budget_approval_at = now(), updated_at = '2000-01-01'
                                     WHERE id = '${DRAFT}' RETURNING (updated_at > '2020-01-01') AS moved`)
      expect(rows).toEqual([{ moved: true }])
    })

    it('publishes a roster, and deletes one (reject): its blocks stay, roster_id nulled', async () => {
      expect(await asService(INSERT_ROSTER_SQL)).toHaveLength(1)
      await runSql('BEGIN')
      try {
        await runSql('SET LOCAL ROLE service_role')
        expect((await db.query(`DELETE FROM public.rosters WHERE id = '${DRAFT}' RETURNING id`)).rows).toEqual([{ id: DRAFT }])
        expect((await db.query(`SELECT roster_id FROM public.shift_blocks WHERE id = '${DRAFT_BLOCK}'`)).rows).toEqual([{ roster_id: null }])
      } finally {
        await runSql('ROLLBACK')
      }
    })

    it('inserts, updates (the trigger fires) and deletes templates', async () => {
      expect(await asService(INSERT_TEMPLATE_SQL)).toEqual([{ id: NEW_TEMPLATE }])
      expect(await asService(`UPDATE public.shift_templates SET name = 'AM2', updated_at = '2000-01-01' WHERE id = '${TEMPLATE}'
                               RETURNING (updated_at > '2020-01-01') AS moved`)).toEqual([{ moved: true }])
      expect(await asService(DELETE_TEMPLATE_SQL)).toEqual([{ id: SPARE }])
    })
  })

  it('is idempotent: a second run passes its own self-check', async () => {
    await expect(runSql(MIG_679)).resolves.toBeDefined()
    expect(await columnAcls()).toEqual(before.acls)
  })
})

describe('the self-check aborts the WHOLE file', () => {
  // The file is one transaction, so a RAISE leaves it aborted; ROLLBACK then
  // restores the pre-679 state for the next case.
  beforeAll(() => boot(), 60_000)
  afterAll(() => db?.close())

  const stillOpen = async () => {
    expect(await holds('authenticated', 'rosters', 'UPDATE')).toBe(true)
    expect(await holds('anon', 'shift_templates', 'DELETE')).toBe(true)
    expect(await policies('rosters')).toHaveLength(4)
    expect(await policies('shift_templates')).toHaveLength(4)
    expect(await grantedColumns('rosters', 'authenticated')).toEqual(ROSTER_GRANTED)
  }
  const mutate = (from, to) => {
    const broken = MIG_679.replace(from, to)
    expect(broken).not.toBe(MIG_679)
    return broken
  }
  const AUTH_REVOKE = 'REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN\n  ON public.rosters, public.shift_templates FROM authenticated;\n'

  it('when the authenticated REVOKE is missing', async () => {
    await expect(runSql(mutate(AUTH_REVOKE, ''))).rejects.toThrow(/mig 679: authenticated still holds INSERT on public\.rosters/)
    await runSql('ROLLBACK')
    await stillOpen()
  })

  it('when the anon REVOKE is missing', async () => {
    await expect(runSql(mutate('REVOKE ALL ON public.rosters, public.shift_templates FROM anon, PUBLIC;\n', '')))
      .rejects.toThrow(/mig 679: anon still holds INSERT on public\.rosters/)
    await runSql('ROLLBACK')
    await stillOpen()
  })

  it('when a write policy is left behind', async () => {
    await expect(runSql(mutate('DROP POLICY IF EXISTS rosters_upd ON public.rosters;\n', '')))
      .rejects.toThrow(/mig 679: public\.rosters should keep exactly its unchanged SELECT policy, has: rosters_select SELECT, rosters_upd UPDATE/)
    await runSql('ROLLBACK')
    await stillOpen()
  })

  it("when a table-level REVOKE ALL from authenticated wipes mig 618's column grants", async () => {
    const broken = mutate('REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN\n  ON public.rosters', 'REVOKE ALL\n  ON public.rosters')
    await expect(runSql(broken)).rejects.toThrow(/mig 679: granted column rosters\.id is no longer readable by authenticated \(mig 618 wiped\)/)
    await runSql('ROLLBACK')
    await stillOpen()
  })

  it("when shift_templates' table-level SELECT is taken (the phone's template embeds)", async () => {
    const broken = mutate(AUTH_REVOKE, `${AUTH_REVOKE}REVOKE SELECT ON public.shift_templates FROM authenticated;\n`)
    await expect(runSql(broken)).rejects.toThrow(/mig 679: authenticated lost SELECT on public\.shift_templates/)
    await runSql('ROLLBACK')
    await stillOpen()
  })

  it("when another grantor's table-level UPDATE survives the owner's REVOKE", async () => {
    await runSql(`BEGIN;
      GRANT UPDATE ON public.shift_templates TO other_grantor WITH GRANT OPTION;
      SET ROLE other_grantor;
      GRANT UPDATE ON public.shift_templates TO authenticated;
      RESET ROLE;`)
    await expect(runSql(MIG_679)).rejects.toThrow(/mig 679: authenticated still holds UPDATE on public\.shift_templates/)
    await runSql('ROLLBACK')
    await stillOpen()
  })

  it("when another grantor's COLUMN-level UPDATE survives", async () => {
    await runSql(`BEGIN;
      GRANT UPDATE (status) ON public.rosters TO other_grantor WITH GRANT OPTION;
      SET ROLE other_grantor;
      GRANT UPDATE (status) ON public.rosters TO authenticated;
      RESET ROLE;`)
    await expect(runSql(MIG_679)).rejects.toThrow(/mig 679: authenticated still holds column-level UPDATE on public\.rosters/)
    await runSql('ROLLBACK')
    await stillOpen()
  })

  it('when authenticated inherits a write through another role', async () => {
    await runSql(`BEGIN;
      GRANT DELETE ON public.rosters TO sneaky;
      GRANT sneaky TO authenticated;`)
    await expect(runSql(MIG_679)).rejects.toThrow(/mig 679: authenticated still holds DELETE on public\.rosters/)
    await runSql('ROLLBACK')
    await stillOpen()
  })

  it("when another grantor's anon SELECT survives", async () => {
    await runSql(`BEGIN;
      GRANT SELECT ON public.shift_templates TO other_grantor WITH GRANT OPTION;
      SET ROLE other_grantor;
      GRANT SELECT ON public.shift_templates TO anon;
      RESET ROLE;`)
    await expect(runSql(MIG_679)).rejects.toThrow(/mig 679: anon still holds SELECT on public\.shift_templates/)
    await runSql('ROLLBACK')
    await stillOpen()
  })

  // Self-check step 6: a column ACL that changes anywhere in the file (here a
  // column grant to a non-client role, which steps 1-4 do not look at).
  it('when a column ACL changes mid-file (step 6, byte compare)', async () => {
    const broken = mutate('DROP POLICY IF EXISTS rosters_ins ON public.rosters;\n',
      'GRANT SELECT (status) ON public.rosters TO other_grantor;\nDROP POLICY IF EXISTS rosters_ins ON public.rosters;\n')
    await expect(runSql(broken)).rejects.toThrow(
      /mig 679: column ACLs changed \(mig 618's SELECT grants must be byte-identical\): rosters\.status \[\{authenticated=r\/postgres\} -> \{authenticated=r\/postgres,other_grantor=r\/postgres\}\]/)
    await runSql('ROLLBACK')
    await stillOpen()
    expect((await columnAcls()).find((r) => r.t === 'rosters' && r.col === 'status').acl).toBe('{authenticated=r/postgres}')
  })

  // Self-check step 5: the one policy left is the SELECT policy, but changed.
  it.each([
    ['its USING', 'ALTER POLICY rosters_select ON public.rosters USING (true);',
      /mig 679: public\.rosters should keep exactly its unchanged SELECT policy, has: rosters_select SELECT$/],
    ['its roles', 'ALTER POLICY shift_templates_select ON public.shift_templates TO authenticated, anon;',
      /mig 679: public\.shift_templates should keep exactly its unchanged SELECT policy, has: shift_templates_select SELECT$/],
  ])('when a SELECT policy changes mid-file: %s (step 5)', async (_, stmt, raises) => {
    const broken = mutate('DROP POLICY IF EXISTS shift_templates_del ON public.shift_templates;\n',
      `DROP POLICY IF EXISTS shift_templates_del ON public.shift_templates;\n${stmt}\n`)
    await expect(runSql(broken)).rejects.toThrow(raises)
    await runSql('ROLLBACK')
    await stillOpen()
    expect([...await policies('rosters'), ...await policies('shift_templates')].filter((p) => p.cmd === 'SELECT').map((p) => p.qual))
      .toEqual([R_READ, 'private.auth_is_in_location(location_id)'])
  })

  // Last in this block: before the fix the file COMMITs here.
  it("when mig 618's column grants are already gone (an empty before-list proves nothing)", async () => {
    await runSql(`BEGIN;
      REVOKE SELECT (period_end) ON public.rosters FROM authenticated;`)
    await expect(runSql(MIG_679)).rejects.toThrow(/mig 679: mig 618's rosters column grants are not as expected before this file ran \(found 4 column ACLs, expected 5\)/)
    await runSql('ROLLBACK')
    await stillOpen()
  })
})

describe("the plan's rollback record restores the authenticated writes exactly", () => {
  beforeAll(() => boot(), 60_000)
  afterAll(() => db?.close())

  it('ACLs (table and column, grantor included) minus anon and the maintenance privileges; column ACL text; policies', async () => {
    const aclBefore = await aclSnapshot()
    const colBefore = await columnAcls()
    const polBefore = await Promise.all(TABLES.map(policies))
    await runSql(MIG_679)
    expect(await aclSnapshot()).not.toEqual(aclBefore)
    await runSql(ROLLBACK_679)
    // Not given back on purpose: anon's grants (it reached no policy; C76
    // closes anon estate-wide) and authenticated's TRUNCATE/REFERENCES/
    // TRIGGER/MAINTAIN (no client used them; C76 takes them everywhere).
    const kept = aclBefore.filter((r) => r.grantee !== 'anon' && r.grantee !== 'PUBLIC'
      && !(r.grantee === 'authenticated' && ['TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'].includes(r.priv)))
    expect(await aclSnapshot()).toEqual(kept)
    expect(await columnAcls()).toEqual(colBefore)
    expect(await Promise.all(TABLES.map(policies))).toEqual(polBefore)
    // …and the hole is back for a head coach (so the record really is the undo).
    expect(await asUser(HEAD, APPROVE_OWN_SQL)).toEqual([{ id: DRAFT }])
  })
})
