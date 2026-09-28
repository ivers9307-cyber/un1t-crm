// NOTESGRANT.1 — behavioural GRANT test for migration 646.
//
// No local Supabase stack exists, so a grant change otherwise gets its first
// execution on prod. This boots an in-process Postgres (PGlite) with the two
// shift tables in their PROD column order, the prod helper functions (mig 626
// versions: active + not tombstoned), the eight prod policies and the prod
// grants (all read out of the catalog on 28 Sep 2026), proves the leak,
// applies the REAL 646 file, and asserts:
//   * the catalog holds exactly the allow-list (column_privileges and the
//     inheritance-aware has_column_privilege),
//   * a coach, a manager and master are all refused every withheld column and
//     `SELECT *`,
//   * the phone's own query shapes (shared/dashboard-data.js, as PostgREST
//     emits them) still return the same rows,
//   * the writes and the Hyrox RPC are untouched,
//   * and the self-check aborts the WHOLE file on the three ways it can go
//     wrong (table grant left, an unclassified column, a missing grant).
// Fictional people only: the repo is public.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { SHIFT_COLUMN_GRANTS } from './helpers/shift-column-grants.js'

const MIG_646 = readFileSync(
  path.resolve(import.meta.dirname, '../supabase/migrations/646_shift_notes_column_grants.sql'),
  'utf8',
)

const LOC_A = 'a0000000-0000-0000-0000-00000000000a'
const LOC_B = 'b0000000-0000-0000-0000-00000000000b'

const COACH = '10000000-0000-0000-0000-000000000001'      // staff at A
const COLLEAGUE = '10000000-0000-0000-0000-000000000002'  // staff at A
const MANAGER = '10000000-0000-0000-0000-000000000003'    // manager at A
const MASTER = '10000000-0000-0000-0000-000000000004'

const ROSTER_PUB = '20000000-0000-0000-0000-000000000001'
const TEMPLATE = '30000000-0000-0000-0000-000000000001'
const BLOCK = '40000000-0000-0000-0000-000000000001'
const OWN = '50000000-0000-0000-0000-000000000001'
const MATE = '50000000-0000-0000-0000-000000000002'

const BLOCK_NOTE = 'MGR-BLOCK-NOTE: short-staffed, keep an eye on the new starter'
const MATE_REASON = 'MGR-PARTIAL: left early, family matter'

const DENIED = /permission denied for (table|relation) shift_(blocks|assignments)/

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

  CREATE TABLE public.locations (id uuid PRIMARY KEY, name text);
  CREATE TABLE public.profiles (
    id uuid PRIMARY KEY, role text NOT NULL, full_name text,
    active boolean DEFAULT true, deleted_at timestamptz
  );
  CREATE TABLE public.profile_locations (
    profile_id uuid REFERENCES public.profiles(id),
    location_id uuid REFERENCES public.locations(id),
    role text NOT NULL,
    PRIMARY KEY (profile_id, location_id)
  );
  CREATE TABLE public.rosters (id uuid PRIMARY KEY, location_id uuid NOT NULL, status text NOT NULL);
  CREATE TABLE public.shift_templates (
    id uuid PRIMARY KEY, location_id uuid, name text, start_time time, end_time time
  );

  -- Prod column order (information_schema.columns, 28 Sep 2026).
  CREATE TABLE public.shift_blocks (
    id uuid PRIMARY KEY,
    location_id uuid NOT NULL REFERENCES public.locations(id),
    template_id uuid NOT NULL REFERENCES public.shift_templates(id),
    block_date date NOT NULL,
    start_time time NOT NULL,
    end_time time NOT NULL,
    max_coaches smallint NOT NULL DEFAULT 1,
    roster_id uuid REFERENCES public.rosters(id),
    notes text,
    created_by uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    min_coaches smallint NOT NULL DEFAULT 1,
    briefing text
  );
  CREATE TABLE public.shift_assignments (
    id uuid PRIMARY KEY,
    block_id uuid NOT NULL REFERENCES public.shift_blocks(id),
    profile_id uuid NOT NULL REFERENCES public.profiles(id),
    notes text,
    status text NOT NULL DEFAULT 'scheduled',
    assigned_by uuid,
    assigned_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    start_time_override time,
    end_time_override time,
    partial_reason text,
    arrived_at timestamptz,
    arrival_source text
  );
  CREATE TABLE public.shift_swap_requests (
    id uuid PRIMARY KEY, requester_id uuid, requester_shift_id uuid REFERENCES public.shift_assignments(id),
    status text, created_at timestamptz DEFAULT now()
  );

  -- Prod grants: Supabase's default table-level ALL to both client roles
  -- (relacl anon=arwdDxtm, authenticated=arwdDxtm on both shift tables)…
  GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated, anon;
  -- …except profiles (mig 153b).
  REVOKE SELECT ON public.profiles FROM authenticated, anon;

  -- Helpers, verbatim from prod (pg_proc.prosrc, 28 Sep; migs 626 + 614).
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
  GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA private TO authenticated;

  -- SECURITY INVOKER, EXECUTE to authenticated + anon on prod (mig 448).
  CREATE FUNCTION public.hyrox_coaches_on_shift(p_location uuid, p_start timestamptz, p_end timestamptz)
  RETURNS TABLE(profile_id uuid) LANGUAGE sql STABLE AS $$
    SELECT DISTINCT a.profile_id
    FROM public.shift_blocks b
    JOIN public.shift_assignments a ON a.block_id = b.id AND COALESCE(a.status, '') <> 'cancelled'
    WHERE b.location_id = p_location
      AND b.block_date = (p_start AT TIME ZONE 'Europe/Dublin')::date
      AND (b.block_date + COALESCE(a.start_time_override, b.start_time)) < (p_end AT TIME ZONE 'Europe/Dublin')
      AND (b.block_date + COALESCE(a.end_time_override, b.end_time)) > (p_start AT TIME ZONE 'Europe/Dublin');
  $$;
  GRANT EXECUTE ON FUNCTION public.hyrox_coaches_on_shift(uuid, timestamptz, timestamptz) TO authenticated, anon;

  ALTER TABLE public.shift_blocks ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.shift_assignments ENABLE ROW LEVEL SECURITY;
`

// The eight prod policies (pg_policies, 28 Sep 2026).
const PROD_POLICIES = `
  CREATE POLICY "shift_blocks_select" ON public.shift_blocks FOR SELECT TO authenticated
    USING (private.auth_can_read_shift_block(location_id, roster_id));
  CREATE POLICY "shift_blocks_ins" ON public.shift_blocks FOR INSERT TO authenticated
    WITH CHECK (private.auth_is_master() OR private.auth_is_manager_at(location_id));
  CREATE POLICY "shift_blocks_upd" ON public.shift_blocks FOR UPDATE TO authenticated
    USING (private.auth_is_master() OR private.auth_is_manager_at(location_id))
    WITH CHECK (private.auth_is_master() OR private.auth_is_manager_at(location_id));
  CREATE POLICY "shift_blocks_del" ON public.shift_blocks FOR DELETE TO authenticated
    USING (private.auth_is_master() OR private.auth_is_manager_at(location_id));

  CREATE POLICY "shift_assignments_select" ON public.shift_assignments FOR SELECT TO authenticated
    USING (private.auth_can_read_shift_assignment(block_id, profile_id));
  CREATE POLICY "shift_assignments_ins" ON public.shift_assignments FOR INSERT TO authenticated
    WITH CHECK (private.auth_is_master() OR EXISTS (SELECT 1 FROM public.shift_blocks b
      WHERE b.id = shift_assignments.block_id AND private.auth_is_manager_at(b.location_id)));
  CREATE POLICY "shift_assignments_upd" ON public.shift_assignments FOR UPDATE TO authenticated
    USING (private.auth_is_master() OR EXISTS (SELECT 1 FROM public.shift_blocks b
      WHERE b.id = shift_assignments.block_id AND private.auth_is_manager_at(b.location_id)))
    WITH CHECK (private.auth_is_master() OR EXISTS (SELECT 1 FROM public.shift_blocks b
      WHERE b.id = shift_assignments.block_id AND private.auth_is_manager_at(b.location_id)));
  CREATE POLICY "shift_assignments_del" ON public.shift_assignments FOR DELETE TO authenticated
    USING (private.auth_is_master() OR EXISTS (SELECT 1 FROM public.shift_blocks b
      WHERE b.id = shift_assignments.block_id AND private.auth_is_manager_at(b.location_id)));
`

const SEED = `
  INSERT INTO public.locations VALUES ('${LOC_A}', 'Studio A'), ('${LOC_B}', 'Studio B');
  INSERT INTO public.profiles (id, role, full_name) VALUES
    ('${COACH}', 'staff', 'Coach One'), ('${COLLEAGUE}', 'staff', 'Coach Two'),
    ('${MANAGER}', 'manager', 'Manager A'), ('${MASTER}', 'master', 'Master');
  INSERT INTO public.profile_locations VALUES
    ('${COACH}', '${LOC_A}', 'staff'), ('${COLLEAGUE}', '${LOC_A}', 'staff'), ('${MANAGER}', '${LOC_A}', 'manager');
  INSERT INTO public.rosters VALUES ('${ROSTER_PUB}', '${LOC_A}', 'published');
  INSERT INTO public.shift_templates VALUES ('${TEMPLATE}', '${LOC_A}', 'AM', '09:00', '10:00');
  INSERT INTO public.shift_blocks (id, location_id, template_id, block_date, start_time, end_time,
                                   max_coaches, min_coaches, roster_id, notes, briefing, created_by)
    VALUES ('${BLOCK}', '${LOC_A}', '${TEMPLATE}', '2026-10-05', '09:00', '10:00',
            3, 2, '${ROSTER_PUB}', '${BLOCK_NOTE}', 'Fire drill at 10', '${MANAGER}');
  INSERT INTO public.shift_assignments (id, block_id, profile_id, notes, status, assigned_by,
                                        start_time_override, end_time_override, partial_reason,
                                        arrived_at, arrival_source)
    VALUES ('${OWN}', '${BLOCK}', '${COACH}', 'MGR-ASSIGN-NOTE: own', 'scheduled', '${MANAGER}',
            NULL, NULL, NULL, NULL, NULL),
           ('${MATE}', '${BLOCK}', '${COLLEAGUE}', 'MGR-ASSIGN-NOTE: colleague', 'scheduled', '${MANAGER}',
            '09:00', '09:40', '${MATE_REASON}', '2026-10-05T07:52:00Z', 'geofence');
  INSERT INTO public.shift_swap_requests VALUES
    ('60000000-0000-0000-0000-000000000001', '${COACH}', '${OWN}', 'pending', now());
`

// fetchDashboardShifts (shared/dashboard-data.js), as PostgREST emits the
// select + the shift_blocks!inner embed: a LEFT JOIN LATERAL subquery on the
// embed's columns, json-built, with the !inner turned into "the embed is
// there". (Test `sb.id`, never `sb IS NOT NULL`: a row value IS NOT NULL only
// when EVERY field is, and briefing is null on every prod block today.)
const PHONE_SHIFTS_SQL = `
  SELECT a.id, a.profile_id, a.start_time_override, a.end_time_override, a.status,
         row_to_json(sb.*) AS shift_blocks
    FROM public.shift_assignments a
    LEFT JOIN LATERAL (
      SELECT b.id, b.block_date, b.start_time, b.end_time, b.briefing, b.location_id, b.roster_id,
             (SELECT row_to_json(r1.*) FROM (SELECT r.status FROM public.rosters r WHERE r.id = b.roster_id) r1) AS rosters,
             (SELECT row_to_json(t1.*) FROM (SELECT t.name, t.start_time, t.end_time FROM public.shift_templates t WHERE t.id = b.template_id) t1) AS shift_templates,
             (SELECT row_to_json(l1.*) FROM (SELECT l.id, l.name FROM public.locations l WHERE l.id = b.location_id) l1) AS locations
        FROM public.shift_blocks b
       WHERE b.id = a.block_id AND b.block_date >= '2026-09-28' AND b.block_date <= '2026-10-31'
    ) sb ON true
   WHERE sb.id IS NOT NULL AND a.profile_id = $1`

// fetchPersonalDashboardData's own-swaps list:
//   requester_shift:shift_assignments!requester_shift_id(
//     shift_blocks!block_id(block_date, start_time, end_time, shift_templates(name)))
const PHONE_SWAPS_SQL = `
  SELECT s.id, s.status,
         (SELECT row_to_json(x.*) FROM (
            SELECT (SELECT row_to_json(y.*) FROM (
                      SELECT b.block_date, b.start_time, b.end_time,
                             (SELECT row_to_json(z.*) FROM (SELECT t.name FROM public.shift_templates t WHERE t.id = b.template_id) z) AS shift_templates
                        FROM public.shift_blocks b WHERE b.id = a.block_id) y) AS shift_blocks
              FROM public.shift_assignments a WHERE a.id = s.requester_shift_id) x) AS requester_shift
    FROM public.shift_swap_requests s
   WHERE s.requester_id = $1`

// fetchTodayOps / fetchUnstaffedBlocksThisWeek (server-only today; granted anyway).
const BLOCKS_WITH_ASSIGNMENTS_SQL = `
  SELECT b.id, b.location_id, b.block_date, b.roster_id,
         (SELECT json_agg(row_to_json(q.*)) FROM (SELECT a.profile_id, a.status FROM public.shift_assignments a WHERE a.block_id = b.id) q) AS shift_assignments
    FROM public.shift_blocks b
   WHERE b.location_id = '${LOC_A}' AND b.block_date = '2026-10-05'`

let db

// PGlite's multi-statement SQL runner (PGlite#exec — a SQL call, no shell).
const runSql = (text) => db.exec(text)

/** Run `sql` as an authenticated JWT for `uid` inside a rolled-back tx; returns rows. */
async function asUser(uid, sql, params = []) {
  await runSql('BEGIN')
  try {
    await db.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: uid, role: 'authenticated' })])
    await runSql('SET LOCAL ROLE authenticated')
    return (await db.query(sql, params)).rows
  } finally {
    await runSql('ROLLBACK')
  }
}

async function asAnon(sql) {
  await runSql('BEGIN')
  try {
    await runSql('SET LOCAL ROLE anon')
    return (await db.query(sql)).rows
  } finally {
    await runSql('ROLLBACK')
  }
}

async function grantedColumns(table, grantee) {
  const { rows } = await db.query(
    `SELECT column_name FROM information_schema.column_privileges
      WHERE table_schema='public' AND table_name=$1 AND grantee=$2 AND privilege_type='SELECT'
      ORDER BY column_name`, [table, grantee])
  return rows.map((r) => r.column_name)
}

async function tableColumns(table) {
  const { rows } = await db.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY column_name`,
    [table])
  return rows.map((r) => r.column_name)
}

const sorted = (xs) => [...xs].sort()
const EVERY_WITHHELD = Object.entries(SHIFT_COLUMN_GRANTS)
  .flatMap(([table, { withheld }]) => withheld.map((col) => [table, col]))

/** A fresh database in the prod pre-646 state. One per top-level describe (a boot is ~2 s). */
async function boot({ migrate = false } = {}) {
  db = new PGlite()
  await runSql(BASE_SCHEMA)
  await runSql(PROD_POLICIES)
  await runSql(SEED)
  if (migrate) await runSql(MIG_646)
}

describe('the column lists match the table (so nothing is withheld by accident)', () => {
  beforeAll(() => boot(), 60_000)
  afterAll(() => db?.close())

  it.each(Object.keys(SHIFT_COLUMN_GRANTS))('%s: granted + withheld = every column, no overlap', async (table) => {
    const { granted, withheld } = SHIFT_COLUMN_GRANTS[table]
    expect(sorted([...granted, ...withheld])).toEqual(await tableColumns(table))
    expect(granted.filter((c) => withheld.includes(c))).toEqual([])
  })

  it("the migration's GRANT and REVOKE lines name exactly the helper's lists", () => {
    for (const [table, { granted, withheld }] of Object.entries(SHIFT_COLUMN_GRANTS)) {
      const grant = MIG_646.match(new RegExp(`^GRANT SELECT \\(([^)]*)\\)\\s+ON public\\.${table} TO authenticated;`, 'm'))
      expect(grant, `GRANT line for ${table}`).not.toBeNull()
      expect(sorted(grant[1].split(',').map((s) => s.trim()))).toEqual(sorted(granted))
      const revoke = MIG_646.match(new RegExp(`^REVOKE SELECT \\(([^)]*)\\)\\s+ON public\\.${table} FROM authenticated, anon;`, 'm'))
      expect(revoke, `column REVOKE line for ${table}`).not.toBeNull()
      expect(sorted(revoke[1].split(',').map((s) => s.trim()))).toEqual(sorted(withheld))
    }
  })
})

describe('before 646: the leak is real (guards against a vacuous pass)', () => {
  beforeAll(() => boot(), 60_000)
  afterAll(() => db?.close())

  it("a plain coach reads the block's manager note, capacity and a colleague's note, reason and arrival", async () => {
    const blocks = await asUser(COACH, `SELECT notes, min_coaches, max_coaches FROM public.shift_blocks`)
    expect(blocks).toEqual([{ notes: BLOCK_NOTE, min_coaches: 2, max_coaches: 3 }])
    const mate = await asUser(COACH, `SELECT notes, partial_reason, arrival_source FROM public.shift_assignments WHERE profile_id = $1`, [COLLEAGUE])
    expect(mate).toEqual([{ notes: 'MGR-ASSIGN-NOTE: colleague', partial_reason: MATE_REASON, arrival_source: 'geofence' }])
  })

  it('SELECT * works: mig 614 filtered rows, never columns', async () => {
    expect(await asUser(COACH, `SELECT * FROM public.shift_assignments`)).toHaveLength(2)
  })

  // The mig 153 lesson, measured: why 646 revokes the TABLE grant first.
  it('a column-level REVOKE alone is silently ignored while the table-level GRANT stands', async () => {
    await runSql('BEGIN')
    try {
      await runSql(`REVOKE SELECT (notes) ON public.shift_blocks FROM authenticated`)
      await db.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: COACH, role: 'authenticated' })])
      await runSql('SET LOCAL ROLE authenticated')
      expect((await db.query(`SELECT notes FROM public.shift_blocks`)).rows).toEqual([{ notes: BLOCK_NOTE }])
      await runSql('RESET ROLE')
      // …and the catalog still lists it, which is why a lockdown is verified
      // against column_privileges and never against the migration text.
      expect(await grantedColumns('shift_blocks', 'authenticated')).toContain('notes')
    } finally {
      await runSql('ROLLBACK')
    }
  })
})

describe('after 646', () => {
  beforeAll(() => boot({ migrate: true }), 60_000)
  afterAll(() => db?.close())

  describe('the catalog', () => {
    it.each(Object.keys(SHIFT_COLUMN_GRANTS))('%s: authenticated holds exactly the allow-list, anon nothing', async (table) => {
      expect(await grantedColumns(table, 'authenticated')).toEqual(sorted(SHIFT_COLUMN_GRANTS[table].granted))
      expect(await grantedColumns(table, 'anon')).toEqual([])
      expect(await grantedColumns(table, 'PUBLIC')).toEqual([])
    })

    it('agrees with the inheritance-aware has_*_privilege, and the writes are untouched', async () => {
      for (const [table, { granted, withheld }] of Object.entries(SHIFT_COLUMN_GRANTS)) {
        for (const col of withheld) {
          const { rows } = await db.query(
            `SELECT has_column_privilege('authenticated', $1, $2, 'SELECT') AS a, has_column_privilege('anon', $1, $2, 'SELECT') AS b`,
            [`public.${table}`, col])
          expect(rows[0], `${table}.${col}`).toEqual({ a: false, b: false })
        }
        for (const col of granted) {
          const { rows } = await db.query(`SELECT has_column_privilege('authenticated', $1, $2, 'SELECT') AS a`, [`public.${table}`, col])
          expect(rows[0].a, `${table}.${col}`).toBe(true)
        }
        const { rows } = await db.query(`
          SELECT has_table_privilege('authenticated', $1, 'SELECT') AS sel,
                 has_table_privilege('authenticated', $1, 'INSERT') AS ins,
                 has_table_privilege('authenticated', $1, 'UPDATE') AS upd,
                 has_table_privilege('authenticated', $1, 'DELETE') AS del`, [`public.${table}`])
        expect(rows[0], table).toEqual({ sel: false, ins: true, upd: true, del: true })
      }
    })
  })

  describe('a coach client', () => {
    it.each(EVERY_WITHHELD)('cannot read %s.%s', async (table, col) => {
      await expect(asUser(COACH, `SELECT ${col} FROM public.${table}`)).rejects.toThrow(DENIED)
    })

    it('cannot SELECT *, and cannot filter or order on a withheld column', async () => {
      await expect(asUser(COACH, `SELECT * FROM public.shift_blocks`)).rejects.toThrow(DENIED)
      await expect(asUser(COACH, `SELECT * FROM public.shift_assignments`)).rejects.toThrow(DENIED)
      await expect(asUser(COACH, `SELECT id FROM public.shift_assignments WHERE partial_reason IS NOT NULL`)).rejects.toThrow(DENIED)
      await expect(asUser(COACH, `SELECT id FROM public.shift_blocks ORDER BY notes`)).rejects.toThrow(DENIED)
    })

    it('cannot reach a withheld column through an embed either', async () => {
      await expect(asUser(COACH, `
        SELECT a.id, (SELECT b.notes FROM public.shift_blocks b WHERE b.id = a.block_id) FROM public.shift_assignments a`))
        .rejects.toThrow(DENIED)
    })

    it('still sees the same ROWS on the granted columns (RLS unchanged)', async () => {
      expect(await asUser(COACH, `SELECT id FROM public.shift_blocks`)).toEqual([{ id: BLOCK }])
      const rows = await asUser(COACH, `SELECT id, profile_id FROM public.shift_assignments ORDER BY id`)
      expect(rows.map((r) => r.id)).toEqual([OWN, MATE])
      expect((await asUser(COACH, `SELECT count(*)::int AS n FROM public.shift_assignments`))[0].n).toBe(2)
    })
  })

  describe('a manager and master are bound by the same grant', () => {
    // A GRANT is per ROLE: every logged-in person is `authenticated`. Managers
    // read notes through service-role /api/schedule/* routes, which bypass
    // grants. Pinned so nobody "restores" the grant for managers and reopens
    // it for coaches.
    it.each([['manager', MANAGER], ['master', MASTER]])('%s cannot read notes or partial_reason directly', async (_, uid) => {
      await expect(asUser(uid, `SELECT notes FROM public.shift_blocks`)).rejects.toThrow(DENIED)
      await expect(asUser(uid, `SELECT partial_reason FROM public.shift_assignments`)).rejects.toThrow(DENIED)
      expect(await asUser(uid, `SELECT id FROM public.shift_assignments`)).toHaveLength(2)
    })
  })

  describe('what the phone reads still reads (shared/dashboard-data.js)', () => {
    it('fetchDashboardShifts: own shifts with the block, roster status, template and studio', async () => {
      const rows = await asUser(COACH, PHONE_SHIFTS_SQL, [COACH])
      expect(rows).toHaveLength(1)
      expect(rows[0].id).toBe(OWN)
      expect(rows[0].shift_blocks).toMatchObject({
        id: BLOCK, block_date: '2026-10-05', start_time: '09:00:00', end_time: '10:00:00',
        briefing: 'Fire drill at 10', location_id: LOC_A, roster_id: ROSTER_PUB,
        rosters: { status: 'published' }, shift_templates: { name: 'AM' }, locations: { id: LOC_A, name: 'Studio A' },
      })
      expect(JSON.stringify(rows)).not.toContain('MGR-')
    })

    it('the own-swaps list embed', async () => {
      const rows = await asUser(COACH, PHONE_SWAPS_SQL, [COACH])
      expect(rows).toHaveLength(1)
      expect(rows[0].requester_shift.shift_blocks).toMatchObject({ block_date: '2026-10-05', shift_templates: { name: 'AM' } })
    })

    it('the blocks-with-assignments shape (fetchTodayOps / fetchUnstaffedBlocksThisWeek)', async () => {
      const rows = await asUser(MANAGER, BLOCKS_WITH_ASSIGNMENTS_SQL)
      expect(rows).toHaveLength(1)
      expect(rows[0].shift_assignments).toHaveLength(2)
    })

    it('the Hyrox RPC (SECURITY INVOKER) still answers for authenticated', async () => {
      const rows = await asUser(MANAGER,
        `SELECT profile_id FROM public.hyrox_coaches_on_shift($1, '2026-10-05T08:15:00Z', '2026-10-05T08:45:00Z') ORDER BY 1`, [LOC_A])
      expect(rows.map((r) => r.profile_id)).toEqual([COACH, COLLEAGUE])
    })

    it('anon reads nothing at all', async () => {
      await expect(asAnon(`SELECT id FROM public.shift_blocks`)).rejects.toThrow(DENIED)
      await expect(asAnon(`SELECT id FROM public.shift_assignments`)).rejects.toThrow(DENIED)
    })
  })

  describe('writes are untouched', () => {
    it('a manager at A may still UPDATE a withheld column (write grant + policy), without reading it back', async () => {
      const rows = await asUser(MANAGER, `UPDATE public.shift_blocks SET notes = 'changed' WHERE id = '${BLOCK}' RETURNING id`)
      expect(rows).toEqual([{ id: BLOCK }])
    })

    it('a coach still may not (the policy, as before)', async () => {
      const rows = await asUser(COACH, `UPDATE public.shift_blocks SET start_time = '08:00' WHERE id = '${BLOCK}' RETURNING id`)
      expect(rows).toEqual([])
    })
  })

  it('is idempotent: a second run passes its own self-check', async () => {
    await expect(runSql(MIG_646)).resolves.toBeDefined()
  })
})

describe('the self-check aborts the WHOLE file', () => {
  // The file is one transaction (BEGIN … COMMIT), so a RAISE leaves it
  // aborted; ROLLBACK then restores the pre-646 state for the next case.
  beforeAll(() => boot(), 60_000)
  afterAll(() => db?.close())

  const blocksNotesReadable = async () =>
    (await db.query(`SELECT has_column_privilege('authenticated','public.shift_blocks','notes','SELECT') AS v`)).rows[0].v

  it('when the table-level REVOKE is missing (the mig 153 mistake)', async () => {
    const broken = MIG_646.replace('REVOKE SELECT ON public.shift_blocks FROM authenticated, anon;\n', '')
    expect(broken).not.toBe(MIG_646)
    await expect(runSql(broken)).rejects.toThrow(/table-level SELECT on public\.shift_blocks survived/)
    await runSql('ROLLBACK')
    expect(await blocksNotesReadable()).toBe(true)
    expect(await grantedColumns('shift_assignments', 'anon')).toContain('partial_reason')
  })

  it('when the table has a column the migration does not classify', async () => {
    // Inside the same transaction, so the ROLLBACK removes the column again.
    await runSql(`BEGIN; ALTER TABLE public.shift_assignments ADD COLUMN pay_note text;`)
    await expect(runSql(MIG_646)).rejects.toThrow(/public\.shift_assignments has column\(s\) this migration does not classify: pay_note/)
    await runSql('ROLLBACK')
    expect(await blocksNotesReadable()).toBe(true)
    expect(await tableColumns('shift_assignments')).not.toContain('pay_note')
  })

  it('when a column in the allow-list is not granted', async () => {
    const broken = MIG_646.replace(
      'GRANT SELECT (id, location_id, template_id, block_date, start_time, end_time, roster_id, briefing)',
      'GRANT SELECT (id, location_id, template_id, block_date, start_time, end_time, roster_id)',
    )
    expect(broken).not.toBe(MIG_646)
    await expect(runSql(broken)).rejects.toThrow(/public\.shift_blocks SELECT grant for authenticated is \[/)
    await runSql('ROLLBACK')
    expect(await blocksNotesReadable()).toBe(true)
  })
})
