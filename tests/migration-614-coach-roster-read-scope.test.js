// COACHSCOPE.1 — behavioural RLS test for migration 614.
//
// WHY THIS FILE EXISTS
// ────────────────────
// This repo has no local Supabase stack, so a policy normally gets its first
// execution on prod. The migration-5xx files beside this one pin SQL SHAPE by
// regex; that cannot tell you whether a staff JWT can read a draft block. So
// this file boots an in-process Postgres (PGlite), recreates the rostering
// tables and the prod helper functions, installs the policies exactly as they
// stood on prod before 614 (read out of pg_policies on 17 Sep), proves the
// leak, applies the real 614 file, and asserts the leak is closed while every
// read a screen depends on still works.
//
// The DDL here is the minimum those policies touch — not the full schema. If
// a later migration changes a helper (private.auth_is_manager_at etc.) or one
// of these policies, update the copy here; the point is replaying the state
// 614 lands on.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const MIGRATION = readFileSync(
  path.resolve(import.meta.dirname, '../supabase/migrations/614_coach_roster_read_scope.sql'),
  'utf8',
)

const LOC_A = 'a0000000-0000-0000-0000-00000000000a'
const LOC_B = 'b0000000-0000-0000-0000-00000000000b'

const STAFF = '10000000-0000-0000-0000-000000000001'       // staff at A
const COLLEAGUE = '10000000-0000-0000-0000-000000000002'   // staff at A
const HEAD_COACH = '10000000-0000-0000-0000-000000000003'  // head_coach at A
const MIXED = '10000000-0000-0000-0000-000000000004'       // global head_coach; staff at A, head_coach at B
const MASTER = '10000000-0000-0000-0000-000000000005'
const OUTSIDER = '10000000-0000-0000-0000-000000000006'    // staff at B only

const ROSTER_PUB = '20000000-0000-0000-0000-000000000001'
const ROSTER_DRAFT = '20000000-0000-0000-0000-000000000002'

const BLOCK_PUB = '30000000-0000-0000-0000-000000000001'
const BLOCK_DRAFT = '30000000-0000-0000-0000-000000000002'
const BLOCK_NOROSTER = '30000000-0000-0000-0000-000000000003'

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
  CREATE TABLE public.profiles (id uuid PRIMARY KEY, role text NOT NULL);
  CREATE TABLE public.profile_locations (
    profile_id uuid REFERENCES public.profiles(id),
    location_id uuid REFERENCES public.locations(id),
    role text NOT NULL,
    PRIMARY KEY (profile_id, location_id)
  );
  CREATE TABLE public.rosters (
    id uuid PRIMARY KEY, location_id uuid NOT NULL REFERENCES public.locations(id),
    status text NOT NULL, projected_contractor_eur numeric, budget_at_publish_eur numeric
  );
  CREATE TABLE public.shift_blocks (
    id uuid PRIMARY KEY, location_id uuid NOT NULL REFERENCES public.locations(id),
    roster_id uuid REFERENCES public.rosters(id), block_date date NOT NULL
  );
  CREATE TABLE public.shift_assignments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    block_id uuid NOT NULL REFERENCES public.shift_blocks(id),
    profile_id uuid NOT NULL REFERENCES public.profiles(id), status text DEFAULT 'assigned'
  );
  CREATE TABLE public.shift_swap_requests (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), location_id uuid NOT NULL,
    requester_id uuid NOT NULL, target_id uuid, status text NOT NULL DEFAULT 'pending'
  );
  CREATE TABLE public.generated_reports (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), location_id uuid NOT NULL);
  CREATE TABLE public.scheduled_reports (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), location_id uuid NOT NULL);

  GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated;

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
  GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA private TO authenticated;

  ALTER TABLE public.rosters ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.shift_blocks ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.shift_assignments ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.shift_swap_requests ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.generated_reports ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.scheduled_reports ENABLE ROW LEVEL SECURITY;
`

// The pre-614 prod policies (pg_policies, 17 Sep) — only the ones 614 drops.
const PRE_614_POLICIES = `
  CREATE POLICY "rosters readable in-location" ON public.rosters FOR SELECT TO authenticated
    USING (private.auth_is_master() OR private.auth_is_in_location(location_id));
  CREATE POLICY "shift_blocks readable in-location" ON public.shift_blocks FOR SELECT TO authenticated
    USING (private.auth_is_master() OR private.auth_is_in_location(location_id));
  CREATE POLICY "shift_assignments readable" ON public.shift_assignments FOR SELECT TO public
    USING (private.auth_is_master() OR profile_id = (SELECT auth.uid()) OR EXISTS (
      SELECT 1 FROM shift_blocks b WHERE b.id = shift_assignments.block_id AND private.auth_is_in_location(b.location_id)));
  CREATE POLICY "shift_swap_requests_select" ON public.shift_swap_requests FOR SELECT TO public
    USING (private.auth_is_admin_or_head_coach() OR requester_id = (SELECT auth.uid()) OR target_id = (SELECT auth.uid()));
  CREATE POLICY "shift_swap_requests_insert" ON public.shift_swap_requests FOR INSERT TO public
    WITH CHECK (private.auth_is_admin_or_head_coach() OR requester_id = (SELECT auth.uid()));
  CREATE POLICY "shift_swap_requests_update" ON public.shift_swap_requests FOR UPDATE TO public
    USING (private.auth_is_admin_or_head_coach()) WITH CHECK (private.auth_is_admin_or_head_coach());
  CREATE POLICY "shift_swap_requests_delete" ON public.shift_swap_requests FOR DELETE TO public
    USING (private.auth_is_admin_or_head_coach());
  CREATE POLICY "Admins can view generated reports" ON public.generated_reports FOR ALL TO public
    USING (private.auth_is_admin_or_head_coach());
  CREATE POLICY "Admins can manage scheduled reports" ON public.scheduled_reports FOR ALL TO public
    USING (private.auth_is_admin_or_head_coach());
`

const SEED = `
  INSERT INTO public.locations VALUES ('${LOC_A}'), ('${LOC_B}');
  INSERT INTO public.profiles VALUES
    ('${STAFF}', 'staff'), ('${COLLEAGUE}', 'staff'), ('${HEAD_COACH}', 'head_coach'),
    ('${MIXED}', 'head_coach'), ('${MASTER}', 'master'), ('${OUTSIDER}', 'staff');
  INSERT INTO public.profile_locations VALUES
    ('${STAFF}', '${LOC_A}', 'staff'), ('${COLLEAGUE}', '${LOC_A}', 'staff'),
    ('${HEAD_COACH}', '${LOC_A}', 'head_coach'),
    ('${MIXED}', '${LOC_A}', 'staff'), ('${MIXED}', '${LOC_B}', 'head_coach'),
    ('${OUTSIDER}', '${LOC_B}', 'staff');
  INSERT INTO public.rosters VALUES
    ('${ROSTER_PUB}', '${LOC_A}', 'published', 1000, 1200),
    ('${ROSTER_DRAFT}', '${LOC_A}', 'draft', 1500, NULL);
  INSERT INTO public.shift_blocks VALUES
    ('${BLOCK_PUB}', '${LOC_A}', '${ROSTER_PUB}', '2026-09-20'),
    ('${BLOCK_DRAFT}', '${LOC_A}', '${ROSTER_DRAFT}', '2026-10-20'),
    ('${BLOCK_NOROSTER}', '${LOC_A}', NULL, '2026-11-20');
  INSERT INTO public.shift_assignments (block_id, profile_id) VALUES
    ('${BLOCK_PUB}', '${STAFF}'), ('${BLOCK_PUB}', '${COLLEAGUE}'),
    ('${BLOCK_DRAFT}', '${STAFF}'), ('${BLOCK_DRAFT}', '${COLLEAGUE}'),
    ('${BLOCK_NOROSTER}', '${COLLEAGUE}');
  INSERT INTO public.shift_swap_requests (location_id, requester_id, target_id, status) VALUES
    ('${LOC_A}', '${STAFF}', NULL, 'pending'),
    ('${LOC_A}', '${COLLEAGUE}', NULL, 'pending'),
    ('${LOC_A}', '${COLLEAGUE}', '${STAFF}', 'pending');
  INSERT INTO public.generated_reports (location_id) VALUES ('${LOC_A}'), ('${LOC_B}');
  INSERT INTO public.scheduled_reports (location_id) VALUES ('${LOC_A}');
`

let db

// PGlite's multi-statement runner (PGlite#exec — a SQL call, no shell).
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

const count = async (uid, sql) => Number((await asUser(uid, `SELECT count(*)::int AS n FROM (${sql}) q`))[0].n)
const draftBlocks = `SELECT b.id FROM public.shift_blocks b LEFT JOIN public.rosters r ON r.id = b.roster_id WHERE r.status IS DISTINCT FROM 'published'`
const draftAssignments = `SELECT a.id FROM public.shift_assignments a WHERE a.block_id IN ('${BLOCK_DRAFT}', '${BLOCK_NOROSTER}')`

beforeAll(async () => {
  db = new PGlite()
  await runSql(BASE_SCHEMA)
  await runSql(PRE_614_POLICIES)
  await runSql(SEED)
}, 60_000)

afterAll(async () => { await db?.close() })

describe('before 614 — the leak is real (guards against a test that passes vacuously)', () => {
  it('a staff JWT reads draft and roster-less blocks and their assignments', async () => {
    expect(await count(STAFF, draftBlocks)).toBe(2)
    expect(await count(STAFF, draftAssignments)).toBe(3)
    expect(await count(STAFF, `SELECT id FROM public.rosters WHERE status = 'draft'`)).toBe(1)
  })

  it('a globally-head_coach person who is staff at A reads A\'s swaps and reports', async () => {
    expect(await count(MIXED, `SELECT id FROM public.shift_swap_requests WHERE location_id = '${LOC_A}'`)).toBe(3)
    expect(await count(MIXED, `SELECT id FROM public.generated_reports WHERE location_id = '${LOC_A}'`)).toBe(1)
  })
})

describe('after 614', () => {
  beforeAll(async () => { await runSql(MIGRATION) }, 30_000)

  it('leaves exactly one permissive policy per (table, command) and no FOR ALL / restrictive', async () => {
    const { rows } = await db.query(`
      SELECT tablename, cmd, count(*)::int AS n, bool_and(permissive = 'PERMISSIVE') AS all_permissive
      FROM pg_policies WHERE schemaname = 'public' GROUP BY 1, 2 ORDER BY 1, 2`)
    for (const r of rows) {
      expect(r.cmd, `${r.tablename}`).not.toBe('ALL')
      expect(r.n, `${r.tablename} ${r.cmd}`).toBe(1)
      expect(r.all_permissive).toBe(true)
    }
    const selects = rows.filter((r) => r.cmd === 'SELECT').map((r) => r.tablename)
    expect(selects).toEqual(expect.arrayContaining([
      'generated_reports', 'rosters', 'scheduled_reports', 'shift_assignments', 'shift_blocks', 'shift_swap_requests',
    ]))
  })

  describe('staff at the location', () => {
    it('cannot see a draft or roster-less block, or any assignment on one — own included', async () => {
      expect(await count(STAFF, draftBlocks)).toBe(0)
      expect(await count(STAFF, draftAssignments)).toBe(0)
      expect(await count(STAFF, `SELECT id FROM public.shift_assignments WHERE profile_id = '${STAFF}' AND block_id = '${BLOCK_DRAFT}'`)).toBe(0)
    })

    it('still reads the published block, its colleagues, and its roster status', async () => {
      expect(await count(STAFF, `SELECT id FROM public.shift_blocks WHERE id = '${BLOCK_PUB}'`)).toBe(1)
      expect(await count(STAFF, `SELECT id FROM public.shift_assignments WHERE block_id = '${BLOCK_PUB}'`)).toBe(2)
    })

    it('keeps the personal-dashboard read shape (own assignments !inner blocks + rosters status)', async () => {
      const rows = await asUser(STAFF, `
        SELECT a.id, b.block_date, r.status
        FROM public.shift_assignments a
        JOIN public.shift_blocks b ON b.id = a.block_id
        LEFT JOIN public.rosters r ON r.id = b.roster_id
        WHERE a.profile_id = $1`, [STAFF])
      expect(rows).toHaveLength(1)
      expect(rows[0].status).toBe('published')
    })

    it('cannot see a draft roster row', async () => {
      expect(await count(STAFF, `SELECT id FROM public.rosters WHERE status = 'draft'`)).toBe(0)
      expect(await count(STAFF, `SELECT id FROM public.rosters WHERE status = 'published'`)).toBe(1)
    })

    it('reads only swaps they requested or are targeted by', async () => {
      const rows = await asUser(STAFF, `SELECT requester_id, target_id FROM public.shift_swap_requests`)
      expect(rows).toHaveLength(2)
      for (const r of rows) expect([r.requester_id, r.target_id]).toContain(STAFF)
    })

    it('cannot read or insert reports', async () => {
      expect(await count(STAFF, `SELECT id FROM public.generated_reports`)).toBe(0)
      expect(await count(STAFF, `SELECT id FROM public.scheduled_reports`)).toBe(0)
      await expect(asUser(STAFF, `INSERT INTO public.generated_reports (location_id) VALUES ('${LOC_A}')`)).rejects.toThrow(/row-level security/)
    })
  })

  describe('head_coach at the location (Manage mode)', () => {
    it('keeps full read of drafts, roster-less blocks, draft rosters and every swap/report at A', async () => {
      expect(await count(HEAD_COACH, draftBlocks)).toBe(2)
      expect(await count(HEAD_COACH, draftAssignments)).toBe(3)
      expect(await count(HEAD_COACH, `SELECT id FROM public.rosters`)).toBe(2)
      expect(await count(HEAD_COACH, `SELECT id FROM public.shift_swap_requests`)).toBe(3)
      expect(await count(HEAD_COACH, `SELECT id FROM public.generated_reports`)).toBe(1)
      expect(await count(HEAD_COACH, `SELECT id FROM public.scheduled_reports`)).toBe(1)
    })

    it('can still update a swap at their location', async () => {
      const rows = await asUser(HEAD_COACH, `UPDATE public.shift_swap_requests SET status = 'rejected' WHERE requester_id = '${COLLEAGUE}' RETURNING id`)
      expect(rows).toHaveLength(2)
    })
  })

  describe('role is judged at the ROW\'s location, not globally', () => {
    it('head_coach at B but staff at A: A\'s drafts, other people\'s swaps and A\'s reports are hidden', async () => {
      expect(await count(MIXED, draftBlocks)).toBe(0)
      expect(await count(MIXED, `SELECT id FROM public.shift_swap_requests WHERE location_id = '${LOC_A}'`)).toBe(0)
      expect(await count(MIXED, `SELECT id FROM public.generated_reports WHERE location_id = '${LOC_A}'`)).toBe(0)
      expect(await count(MIXED, `SELECT id FROM public.generated_reports WHERE location_id = '${LOC_B}'`)).toBe(1)
    })

    it('cannot update a swap at A', async () => {
      const rows = await asUser(MIXED, `UPDATE public.shift_swap_requests SET status = 'rejected' RETURNING id`)
      expect(rows).toHaveLength(0)
    })
  })

  describe('everyone else', () => {
    it('master keeps estate-wide read', async () => {
      expect(await count(MASTER, `SELECT id FROM public.shift_blocks`)).toBe(3)
      expect(await count(MASTER, `SELECT id FROM public.shift_assignments`)).toBe(5)
      expect(await count(MASTER, `SELECT id FROM public.generated_reports`)).toBe(2)
    })

    it('a coach at another location sees nothing at A', async () => {
      expect(await count(OUTSIDER, `SELECT id FROM public.shift_blocks`)).toBe(0)
      expect(await count(OUTSIDER, `SELECT id FROM public.shift_assignments`)).toBe(0)
      expect(await count(OUTSIDER, `SELECT id FROM public.rosters`)).toBe(0)
    })

    it('a coach can insert their own swap at their location, not at one they do not belong to', async () => {
      await expect(asUser(OUTSIDER, `INSERT INTO public.shift_swap_requests (location_id, requester_id) VALUES ('${LOC_A}', '${OUTSIDER}')`))
        .rejects.toThrow(/row-level security/)
      const ok = await asUser(STAFF, `INSERT INTO public.shift_swap_requests (location_id, requester_id) VALUES ('${LOC_A}', '${STAFF}') RETURNING id`)
      expect(ok).toHaveLength(1)
    })
  })
})
