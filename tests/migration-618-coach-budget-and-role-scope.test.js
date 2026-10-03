// RLSSCOPE.2 — behavioural GRANT + RLS test for migration 618.
//
// WHY THIS FILE EXISTS
// ────────────────────
// Same reason as tests/migration-614-coach-roster-read-scope.test.js: no local
// Supabase stack, so a grant change otherwise gets its first execution on
// prod. This boots an in-process Postgres (PGlite), recreates the tables,
// prod's helper functions and the CURRENT prod policies + grants (read out of
// pg_policies / information_schema on 17 Sep, with mig 614 applied), proves
// the leak, applies the real 618 file, and asserts the close — plus the two
// things the migration's header claims and must not be trusted on:
//
//   * a column-level REVOKE is a NO-OP while a table-level GRANT stands
//     (the mig 153 → 153b lesson, re-measured rather than recited), and
//   * a `security_invoker` view CANNOT hide a base-table column, which is why
//     618 ships a column GRANT and no `rosters_public` view.
//
// The DDL here is the minimum those policies and grants touch, not the full
// schema. If a later migration changes a helper or one of these policies,
// update the copy here; the point is replaying the state 618 lands on.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const MIGRATION = readFileSync(
  path.resolve(import.meta.dirname, '../supabase/migrations/618_coach_budget_and_role_scope.sql'),
  'utf8',
)

const LOC_A = 'a0000000-0000-0000-0000-00000000000a'
const LOC_B = 'b0000000-0000-0000-0000-00000000000b'

const STAFF = '10000000-0000-0000-0000-000000000001'       // staff at A
const MANAGER = '10000000-0000-0000-0000-000000000002'     // manager at A
const MIXED = '10000000-0000-0000-0000-000000000003'       // global head_coach; staff at A, head_coach at B
const MASTER = '10000000-0000-0000-0000-000000000004'
const MEMBER_USER = '10000000-0000-0000-0000-000000000005' // a customer (contacts.user_id), not staff

const ROSTER_PUB = '20000000-0000-0000-0000-000000000001'
const BLOCK_PUB = '30000000-0000-0000-0000-000000000001'

const BRIDGE_A = '40000000-0000-0000-0000-00000000000a'
const BRIDGE_B = '40000000-0000-0000-0000-00000000000b'
const CONTACT = '50000000-0000-0000-0000-000000000001'
const STRAP_A = '60000000-0000-0000-0000-00000000000a'
const STRAP_B = '60000000-0000-0000-0000-00000000000b'

const GRANTED_COLS = ['id', 'location_id', 'period_end', 'period_start', 'status']
const WITHHELD_COLS = [
  'projected_contractor_eur', 'budget_at_publish_eur',
  'over_budget_approval_by', 'over_budget_approval_at', 'notes',
]

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

  CREATE TABLE public.locations (id uuid PRIMARY KEY);
  CREATE TABLE public.profiles (
    id uuid PRIMARY KEY, role text NOT NULL, full_name text, annual_salary numeric
  );
  CREATE TABLE public.profile_locations (
    profile_id uuid REFERENCES public.profiles(id),
    location_id uuid REFERENCES public.locations(id),
    role text NOT NULL,
    PRIMARY KEY (profile_id, location_id)
  );
  CREATE TABLE public.contacts (id uuid PRIMARY KEY, user_id uuid);

  -- rosters: the prod column list, in prod order (information_schema, 17 Sep).
  CREATE TABLE public.rosters (
    id uuid PRIMARY KEY,
    location_id uuid NOT NULL REFERENCES public.locations(id),
    period_start date, period_end date,
    status text NOT NULL,
    notes text,
    created_by uuid, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
    published_at timestamptz, published_by uuid,
    projected_contractor_eur numeric, budget_at_publish_eur numeric,
    over_budget_approval_by uuid, over_budget_approval_at timestamptz,
    superseded_at timestamptz, superseded_by uuid,
    requested_period_start date, requested_period_end date
  );
  CREATE TABLE public.shift_blocks (
    id uuid PRIMARY KEY, location_id uuid NOT NULL REFERENCES public.locations(id),
    roster_id uuid REFERENCES public.rosters(id), block_date date NOT NULL
  );
  CREATE TABLE public.ble_bridges (
    id uuid PRIMARY KEY, location_id uuid NOT NULL REFERENCES public.locations(id), name text
  );
  CREATE TABLE public.strap_assignments (
    id uuid PRIMARY KEY,
    ble_bridge_id uuid NOT NULL REFERENCES public.ble_bridges(id),
    contact_id uuid NOT NULL REFERENCES public.contacts(id),
    strap_identifier text NOT NULL,
    ended_at timestamptz
  );

  -- Supabase's default: table-level SELECT to both client roles.
  GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated;
  GRANT SELECT ON ALL TABLES IN SCHEMA public TO anon;
  -- …except profiles, where mig 153b revoked table SELECT and nothing put it
  -- back (verified live 17 Sep: has_table_privilege = false for both roles).
  REVOKE SELECT ON public.profiles FROM authenticated, anon;

  -- Helper functions, verbatim from prod (pg_get_functiondef, 17 Sep).
  CREATE FUNCTION private.auth_is_master() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
    SELECT EXISTS (SELECT 1 FROM public.profiles WHERE id = (SELECT auth.uid()) AND role = 'master')
  $$;
  CREATE FUNCTION private.auth_is_in_location(loc_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
    SELECT loc_id IS NOT NULL AND (private.auth_is_master() OR EXISTS (
      SELECT 1 FROM public.profile_locations WHERE profile_id = (SELECT auth.uid()) AND location_id = loc_id))
  $$;
  CREATE FUNCTION private.auth_is_manager_at(p_location_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
    SELECT private.auth_is_master() OR EXISTS (
      SELECT 1 FROM public.profile_locations pl WHERE pl.profile_id = (SELECT auth.uid())
        AND pl.location_id = p_location_id AND pl.role IN ('owner','manager','head_coach'))
  $$;
  CREATE FUNCTION private.auth_is_admin_or_head_coach() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = ANY (ARRAY['owner','manager','head_coach']))
  $$;
  CREATE FUNCTION private.auth_contact_id() RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT id FROM public.contacts WHERE user_id = auth.uid()
  $$;
  CREATE FUNCTION private.auth_can_view_all_profiles() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
    SELECT coalesce((SELECT role IN ('owner','manager','head_coach','master') FROM public.profiles WHERE id = (SELECT auth.uid())), false)
  $$;
  GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA private TO authenticated;

  ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.rosters ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.shift_blocks ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.ble_bridges ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.strap_assignments ENABLE ROW LEVEL SECURITY;
`

// Prod policies as they stand AFTER mig 614 and BEFORE 618 (pg_policies, 17 Sep).
const PRE_618_POLICIES = `
  CREATE POLICY "profiles_select" ON public.profiles FOR SELECT TO authenticated
    USING ((SELECT private.auth_is_master()) OR (id = (SELECT auth.uid())) OR private.auth_can_view_all_profiles());

  CREATE POLICY "rosters_select" ON public.rosters FOR SELECT TO authenticated
    USING (private.auth_is_manager_at(location_id)
           OR (private.auth_is_in_location(location_id) AND status IN ('published','superseded')));
  CREATE POLICY "shift_blocks_select" ON public.shift_blocks FOR SELECT TO authenticated
    USING (private.auth_is_manager_at(location_id) OR (private.auth_is_in_location(location_id)
      AND EXISTS (SELECT 1 FROM public.rosters r WHERE r.id = shift_blocks.roster_id AND r.status = 'published')));
  CREATE POLICY "ble_bridges_select" ON public.ble_bridges FOR SELECT TO authenticated
    USING (private.auth_is_in_location(location_id));

  CREATE POLICY "strap_assignments_read" ON public.strap_assignments FOR SELECT TO public USING (
    private.auth_is_admin_or_head_coach()
    OR (contact_id = private.auth_contact_id())
    OR (EXISTS (SELECT 1 FROM ble_bridges b WHERE b.id = strap_assignments.ble_bridge_id AND private.auth_is_in_location(b.location_id))));
  CREATE POLICY "strap_assignments_ins" ON public.strap_assignments FOR INSERT TO public
    WITH CHECK (private.auth_is_admin_or_head_coach());
  CREATE POLICY "strap_assignments_upd" ON public.strap_assignments FOR UPDATE TO public
    USING (private.auth_is_admin_or_head_coach()) WITH CHECK (private.auth_is_admin_or_head_coach());
  CREATE POLICY "strap_assignments_del" ON public.strap_assignments FOR DELETE TO public
    USING (private.auth_is_admin_or_head_coach());
`

const SEED = `
  INSERT INTO public.locations VALUES ('${LOC_A}'), ('${LOC_B}');
  INSERT INTO public.profiles (id, role, full_name, annual_salary) VALUES
    ('${STAFF}', 'staff', 'Coach A', NULL),
    ('${MANAGER}', 'manager', 'Manager A', 60000),
    ('${MIXED}', 'head_coach', 'Mixed', 40000),
    ('${MASTER}', 'master', 'Master', NULL);
  INSERT INTO public.profile_locations VALUES
    ('${STAFF}', '${LOC_A}', 'staff'),
    ('${MANAGER}', '${LOC_A}', 'manager'),
    ('${MIXED}', '${LOC_A}', 'staff'), ('${MIXED}', '${LOC_B}', 'head_coach');
  INSERT INTO public.contacts VALUES ('${CONTACT}', '${MEMBER_USER}');
  INSERT INTO public.rosters (id, location_id, period_start, period_end, status, notes,
                              projected_contractor_eur, budget_at_publish_eur,
                              over_budget_approval_by, over_budget_approval_at)
    VALUES ('${ROSTER_PUB}', '${LOC_A}', '2026-09-21', '2026-09-27', 'published',
            'manager working notes', 4231.50, 4000.00, '${MANAGER}', now());
  INSERT INTO public.shift_blocks VALUES ('${BLOCK_PUB}', '${LOC_A}', '${ROSTER_PUB}', '2026-09-22');
  INSERT INTO public.ble_bridges VALUES ('${BRIDGE_A}', '${LOC_A}', 'Stillorgan Pi'), ('${BRIDGE_B}', '${LOC_B}', 'Hatch Pi');
  INSERT INTO public.strap_assignments VALUES
    ('${STRAP_A}', '${BRIDGE_A}', '${CONTACT}', 'ANT:1234', NULL),
    ('${STRAP_B}', '${BRIDGE_B}', '${CONTACT}', 'ANT:5678', NULL);
`

let db

// PGlite's multi-statement SQL runner (PGlite#exec — a SQL call, no shell).
const runSql = (text) => db.exec(text)

/** Run `sql` as an authenticated JWT for `uid` inside a rolled-back tx; returns rows. */
async function asUser(uid, sql, params = []) {
  await runSql('BEGIN')
  try {
    await db.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: uid, role: 'authenticated' })])
    await runSql('SET LOCAL ROLE authenticated')
    const res = await db.query(sql, params)
    return res.rows
  } finally {
    await runSql('ROLLBACK')
  }
}

/** Same, as the anon role with no JWT. */
async function asAnon(sql) {
  await runSql('BEGIN')
  try {
    await runSql('SET LOCAL ROLE anon')
    const res = await db.query(sql)
    return res.rows
  } finally {
    await runSql('ROLLBACK')
  }
}

const count = async (uid, sql) => Number((await asUser(uid, `SELECT count(*)::int AS n FROM (${sql}) q`))[0].n)

/** The SELECT column grants a role holds on `table`, sorted. */
async function grantedColumns(table, grantee) {
  const { rows } = await db.query(
    `SELECT column_name FROM information_schema.column_privileges
      WHERE table_schema='public' AND table_name=$1 AND grantee=$2 AND privilege_type='SELECT'
      ORDER BY column_name`, [table, grantee])
  return rows.map((r) => r.column_name)
}

beforeAll(async () => {
  db = new PGlite()
  await runSql(BASE_SCHEMA)
  await runSql(PRE_618_POLICIES)
  await runSql(SEED)
}, 60_000)

afterAll(async () => { await db?.close() })

describe('before 618 — the leak is real (guards against a test that passes vacuously)', () => {
  it('a staff JWT reads the published roster budget columns, approver and notes', async () => {
    const rows = await asUser(STAFF, `
      SELECT projected_contractor_eur, budget_at_publish_eur, over_budget_approval_by, notes
        FROM public.rosters WHERE id = '${ROSTER_PUB}'`)
    expect(rows).toHaveLength(1)
    expect(Number(rows[0].projected_contractor_eur)).toBe(4231.5)
    expect(Number(rows[0].budget_at_publish_eur)).toBe(4000)
    expect(rows[0].over_budget_approval_by).toBe(MANAGER)
    expect(rows[0].notes).toBe('manager working notes')
  })

  it('a staff JWT can SELECT * — mig 614 filtered rows, never columns', async () => {
    const rows = await asUser(STAFF, `SELECT * FROM public.rosters`)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toHaveProperty('projected_contractor_eur')
  })

  it('a globally-head_coach person who is only staff at A reads and writes A straps', async () => {
    expect(await count(MIXED, `SELECT id FROM public.strap_assignments`)).toBe(2)
    const updated = await asUser(MIXED, `UPDATE public.strap_assignments SET ended_at = now() WHERE id = '${STRAP_A}' RETURNING id`)
    expect(updated).toHaveLength(1)
  })

  // The mig 153 lesson, measured instead of recited: this is why 618 revokes
  // the TABLE grant before granting columns. Restored immediately.
  it('a column-level REVOKE is silently ignored while the table-level GRANT stands', async () => {
    await runSql(`REVOKE SELECT (projected_contractor_eur, budget_at_publish_eur) ON public.rosters FROM authenticated`)
    const rows = await asUser(STAFF, `SELECT projected_contractor_eur FROM public.rosters`)
    expect(rows).toHaveLength(1)
    expect(Number(rows[0].projected_contractor_eur)).toBe(4231.5)
    // …and the catalog still lists the column as granted, which is exactly why
    // a claimed lockdown must be verified against column_privileges and never
    // against the migration text.
    expect(await grantedColumns('rosters', 'authenticated')).toContain('projected_contractor_eur')
    await runSql(`GRANT SELECT ON public.rosters TO authenticated`)
  })
})

describe('after 618', () => {
  beforeAll(async () => { await runSql(MIGRATION) }, 30_000)

  describe('rosters — the grant', () => {
    it('leaves authenticated exactly the five non-sensitive columns, and anon none', async () => {
      expect(await grantedColumns('rosters', 'authenticated')).toEqual(GRANTED_COLS)
      expect(await grantedColumns('rosters', 'anon')).toEqual([])
    })

    it('is inheritance-aware — has_column_privilege agrees with the catalog', async () => {
      const { rows } = await db.query(`
        SELECT has_column_privilege('authenticated','public.rosters','projected_contractor_eur','SELECT') AS projected,
               has_column_privilege('authenticated','public.rosters','budget_at_publish_eur','SELECT')    AS budget,
               has_column_privilege('authenticated','public.rosters','notes','SELECT')                    AS notes,
               has_column_privilege('authenticated','public.rosters','status','SELECT')                   AS status,
               has_column_privilege('authenticated','public.rosters','id','SELECT')                       AS id`)
      expect(rows[0]).toEqual({ projected: false, budget: false, notes: false, status: true, id: true })
    })
  })

  describe('rosters — a coach client', () => {
    it.each(WITHHELD_COLS)('cannot read %s', async (col) => {
      await expect(asUser(STAFF, `SELECT ${col} FROM public.rosters`))
        .rejects.toThrow(/permission denied for (table|relation) rosters/)
    })

    it('cannot SELECT * and cannot filter on a withheld column either', async () => {
      await expect(asUser(STAFF, `SELECT * FROM public.rosters`))
        .rejects.toThrow(/permission denied for (table|relation) rosters/)
      await expect(asUser(STAFF, `SELECT id FROM public.rosters WHERE projected_contractor_eur > 0`))
        .rejects.toThrow(/permission denied for (table|relation) rosters/)
    })

    it('still reads the published roster on the five granted columns', async () => {
      const rows = await asUser(STAFF, `SELECT id, location_id, period_start, period_end, status FROM public.rosters`)
      expect(rows).toHaveLength(1)
      expect(rows[0].status).toBe('published')
    })
  })

  describe('rosters — a MANAGER client is bound by the same grant', () => {
    // A GRANT is per ROLE, not per user: every logged-in person is
    // `authenticated`. A manager reads the budget through
    // GET /api/schedule/rosters (service_role), which bypasses grants — the
    // whole point of the fix. Pinned so nobody "restores" the grant for
    // managers and reopens the leak for coaches.
    it('cannot read the budget columns directly', async () => {
      await expect(asUser(MANAGER, `SELECT projected_contractor_eur FROM public.rosters`))
        .rejects.toThrow(/permission denied for (table|relation) rosters/)
      expect(await count(MANAGER, `SELECT id FROM public.rosters`)).toBe(1)
    })

    it('master is bound too', async () => {
      await expect(asUser(MASTER, `SELECT budget_at_publish_eur FROM public.rosters`))
        .rejects.toThrow(/permission denied for (table|relation) rosters/)
    })
  })

  describe('rosters — what the mobile dashboard needs still reads', () => {
    // shared/dashboard-data.js fetchDashboardShifts:
    //   shift_blocks!inner ( …, roster_id, rosters:roster_id ( status ), … )
    // PostgREST resolves an embed as a join on rosters.id projecting
    // rosters.status. Both shapes it emits are covered.
    it('the lateral-subquery embed shape works for a plain coach', async () => {
      const rows = await asUser(STAFF, `
        SELECT b.id,
               (SELECT row_to_json(t) FROM (SELECT r.status FROM public.rosters r WHERE r.id = b.roster_id) t) AS rosters
          FROM public.shift_blocks b`)
      expect(rows).toHaveLength(1)
      expect(rows[0].rosters).toEqual({ status: 'published' })
    })

    it('the !inner join shape works for a plain coach', async () => {
      const rows = await asUser(STAFF, `
        SELECT b.id, b.block_date, r.status
          FROM public.shift_blocks b
          LEFT JOIN public.rosters r ON r.id = b.roster_id`)
      expect(rows).toHaveLength(1)
      expect(rows[0].status).toBe('published')
    })

    it('count(*) still works — it needs no column privilege', async () => {
      expect(await count(STAFF, `SELECT id FROM public.rosters`)).toBe(1)
    })

    it('anon reads nothing at all', async () => {
      await expect(asAnon(`SELECT status FROM public.rosters`))
        .rejects.toThrow(/permission denied for (table|relation) rosters/)
    })
  })

  describe('why 618 ships no rosters_public view (Option A view half does not work)', () => {
    // CLAUDE.md requires WITH (security_invoker = on) on every view, and a
    // security_invoker view checks privileges on its BASE TABLE as the
    // invoking user. So the view can only ever show what the base grant
    // already allows — it hides nothing, and a view over a withheld column
    // fails outright.
    it('a security_invoker view over the granted columns adds nothing the grant did not already give', async () => {
      await runSql(`
        CREATE VIEW public.rosters_public WITH (security_invoker = on) AS
          SELECT id, location_id, period_start, period_end, status FROM public.rosters;
        GRANT SELECT ON public.rosters_public TO authenticated;`)
      const rows = await asUser(STAFF, `SELECT status FROM public.rosters_public`)
      expect(rows).toHaveLength(1)
      expect(rows[0].status).toBe('published')
    })

    it('and a security_invoker view over a WITHHELD column is refused on the base table', async () => {
      await runSql(`
        CREATE VIEW public.rosters_budget_v WITH (security_invoker = on) AS
          SELECT id, projected_contractor_eur FROM public.rosters;
        GRANT SELECT ON public.rosters_budget_v TO authenticated;`)
      await expect(asUser(STAFF, `SELECT projected_contractor_eur FROM public.rosters_budget_v`))
        .rejects.toThrow(/permission denied for (table|relation) rosters/)
      await runSql(`DROP VIEW public.rosters_budget_v; DROP VIEW public.rosters_public;`)
    })
  })

  describe('strap_assignments — the role at the BRIDGE location', () => {
    it('leaves one permissive policy per command, none FOR ALL, all TO authenticated', async () => {
      const { rows } = await db.query(`
        SELECT cmd, count(*)::int AS n, bool_and(permissive = 'PERMISSIVE') AS all_permissive,
               bool_and(roles::text = '{authenticated}') AS all_authenticated
          FROM pg_policies WHERE schemaname='public' AND tablename='strap_assignments'
         GROUP BY cmd ORDER BY cmd`)
      expect(rows.map((r) => r.cmd).sort()).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE'])
      for (const r of rows) {
        expect(r.n, r.cmd).toBe(1)
        expect(r.all_permissive, r.cmd).toBe(true)
        expect(r.all_authenticated, r.cmd).toBe(true)
      }
    })

    it('a global head_coach who is only staff at A can no longer write A straps', async () => {
      const updated = await asUser(MIXED, `UPDATE public.strap_assignments SET ended_at = now() WHERE id = '${STRAP_A}' RETURNING id`)
      expect(updated).toHaveLength(0)
      await expect(asUser(MIXED, `INSERT INTO public.strap_assignments VALUES (gen_random_uuid(), '${BRIDGE_A}', '${CONTACT}', 'ANT:9', NULL)`))
        .rejects.toThrow(/row-level security/)
      const deleted = await asUser(MIXED, `DELETE FROM public.strap_assignments WHERE id = '${STRAP_A}' RETURNING id`)
      expect(deleted).toHaveLength(0)
    })

    it('…but keeps every right they have at B, where they ARE head_coach', async () => {
      const updated = await asUser(MIXED, `UPDATE public.strap_assignments SET ended_at = now() WHERE id = '${STRAP_B}' RETURNING id`)
      expect(updated).toHaveLength(1)
      const inserted = await asUser(MIXED, `INSERT INTO public.strap_assignments VALUES (gen_random_uuid(), '${BRIDGE_B}', '${CONTACT}', 'ANT:9', NULL) RETURNING id`)
      expect(inserted).toHaveLength(1)
    })

    it('a manager at A writes A straps but not B straps', async () => {
      expect(await asUser(MANAGER, `UPDATE public.strap_assignments SET ended_at = now() WHERE id = '${STRAP_A}' RETURNING id`)).toHaveLength(1)
      expect(await asUser(MANAGER, `UPDATE public.strap_assignments SET ended_at = now() WHERE id = '${STRAP_B}' RETURNING id`)).toHaveLength(0)
    })

    it('master gains the estate-wide write the old global-role helper denied them', async () => {
      // auth_is_admin_or_head_coach() checks role IN (owner, manager,
      // head_coach) and excludes 'master'; auth_is_manager_at() starts with
      // auth_is_master().
      expect(await asUser(MASTER, `UPDATE public.strap_assignments SET ended_at = now() RETURNING id`)).toHaveLength(2)
    })

    it('a member of the bridge location still READS its straps (the pairing screen)', async () => {
      expect(await count(STAFF, `SELECT id FROM public.strap_assignments WHERE ble_bridge_id = '${BRIDGE_A}'`)).toBe(1)
      expect(await count(STAFF, `SELECT id FROM public.strap_assignments WHERE ble_bridge_id = '${BRIDGE_B}'`)).toBe(0)
    })

    it('the strap own contact still reads their own row, at either location', async () => {
      expect(await count(MEMBER_USER, `SELECT id FROM public.strap_assignments`)).toBe(2)
    })

    it('and that contact still cannot write one', async () => {
      expect(await asUser(MEMBER_USER, `UPDATE public.strap_assignments SET ended_at = now() RETURNING id`)).toHaveLength(0)
    })

    it('anon reads nothing — it never could, and TO public → TO authenticated kept it that way', async () => {
      expect(await asAnon(`SELECT id FROM public.strap_assignments`)).toHaveLength(0)
    })
  })

  describe('profiles_select is left alone because it is unreachable', () => {
    // FINDING 2b. The policy checks the GLOBAL role via
    // auth_can_view_all_profiles(), but mig 153b table-level REVOKE means no
    // client-side query ever gets far enough to evaluate it. Verified live on
    // 17 Sep; pinned here so a re-grant lands as a failing test rather than a
    // silent reopening of the comp-column leak.
    it('authenticated and anon hold no SELECT on profiles, at table or column level', async () => {
      expect(await grantedColumns('profiles', 'authenticated')).toEqual([])
      expect(await grantedColumns('profiles', 'anon')).toEqual([])
      const { rows } = await db.query(`
        SELECT has_table_privilege('authenticated','public.profiles','SELECT') AS a,
               has_table_privilege('anon','public.profiles','SELECT')          AS b,
               has_column_privilege('authenticated','public.profiles','full_name','SELECT')     AS c,
               has_column_privilege('authenticated','public.profiles','annual_salary','SELECT') AS d`)
      expect(rows[0]).toEqual({ a: false, b: false, c: false, d: false })
    })

    it('so even a global manager — whom the policy would wave through — is refused', async () => {
      await expect(asUser(MANAGER, `SELECT annual_salary FROM public.profiles`))
        .rejects.toThrow(/permission denied for (table|relation) profiles/)
      await expect(asUser(MANAGER, `SELECT full_name FROM public.profiles WHERE id = '${MANAGER}'`))
        .rejects.toThrow(/permission denied for (table|relation) profiles/)
    })
  })
})
