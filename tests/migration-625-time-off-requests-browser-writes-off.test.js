// LEAVEGUARD.1 — behavioural test for migration 625.
//
// Same reason as the 622/624 replays: no local Supabase stack, so DDL would
// otherwise get its first execution on prod. This boots an in-process Postgres
// (PGlite), recreates time_off_requests with the grants prod showed on 21 Sep
// 2026 (anon and authenticated: INSERT, SELECT, UPDATE, DELETE, TRUNCATE,
// REFERENCES, TRIGGER, all granted by the table owner) and the three live
// policies, installs the REAL mig 616 allowance trigger, and proves:
//
//   * BEFORE: a coach's own JWT can INSERT their leave already `approved`, and
//     the allowance is not charged (the hole this file closes);
//   * the self-check aborts the WHOLE file when a write grant survives (a grant
//     made by another grantor, or one inherited through role membership that
//     information_schema does not list), leaving nothing applied;
//   * AFTER 624 + 625: INSERT, UPDATE, DELETE and TRUNCATE are refused for the
//     browser roles; SELECT still returns exactly the rows it did; the INSERT
//     and UPDATE policies are gone (one SELECT policy left); service_role still inserts and approves (and the approve
//     still charges through the trigger).
//
// `npm run check:rls-restrictive` is run separately (it reads the migration
// files, not a database); 625 only drops a permissive INSERT policy.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const read = (name) => readFileSync(path.resolve(import.meta.dirname, '../supabase/migrations', name), 'utf8')
const MIG_616 = read('616_time_off_created_by_allowance_seed.sql')
const MIG_624 = read('624_time_off_cancel_request.sql')
const MIG_625 = read('625_time_off_requests_browser_writes_off.sql')

const LOC = 'a0000000-0000-0000-0000-00000000000a'
const MANAGER = '10000000-0000-0000-0000-000000000001'
const OWNER = '10000000-0000-0000-0000-000000000002'
const COACH = '10000000-0000-0000-0000-000000000003'
const COACH_LEAVE = '20000000-0000-0000-0000-000000000002'

// Prod's shape: the table owner granted everything below to both client roles.
const BASE_SCHEMA = `
  CREATE ROLE anon NOLOGIN;
  CREATE ROLE authenticated NOLOGIN;
  CREATE ROLE service_role NOLOGIN BYPASSRLS;
  CREATE ROLE other_grantor NOLOGIN;
  CREATE SCHEMA auth;
  CREATE SCHEMA private;
  GRANT USAGE ON SCHEMA auth, private, public TO authenticated, anon, service_role;

  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
    SELECT nullif(current_setting('request.jwt.claims', true)::json->>'sub', '')::uuid
  $$;
  GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated, anon;

  CREATE TABLE public.locations (id uuid PRIMARY KEY);
  CREATE TABLE public.profiles (id uuid PRIMARY KEY, role text NOT NULL, full_name text, employment_type text);
  CREATE TABLE public.profile_locations (
    profile_id uuid REFERENCES public.profiles(id), location_id uuid REFERENCES public.locations(id),
    role text NOT NULL, PRIMARY KEY (profile_id, location_id)
  );
  CREATE TABLE public.profile_compensation (profile_id uuid PRIMARY KEY REFERENCES public.profiles(id), annual_leave_entitlement numeric);
  CREATE TABLE public.staff_allowances (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    profile_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    year int NOT NULL,
    total_days numeric(5,1) NOT NULL DEFAULT 20,
    used_days numeric(5,1) NOT NULL DEFAULT 0,
    carried_over numeric(5,1) NOT NULL DEFAULT 0,
    created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
    UNIQUE (profile_id, year)
  );
  CREATE TABLE public.time_off_requests (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    profile_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    location_id uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
    type text NOT NULL CHECK (type = ANY (ARRAY['holiday','sick','unpaid','other','unavailable'])),
    start_date date NOT NULL, end_date date NOT NULL,
    total_days numeric(5,1) NOT NULL DEFAULT 1,
    reason text,
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
    reviewed_by uuid REFERENCES public.profiles(id), reviewed_at timestamptz, review_note text,
    created_by uuid REFERENCES public.profiles(id),
    created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
    CONSTRAINT valid_date_range CHECK (end_date >= start_date)
  );
  CREATE FUNCTION public.update_holiday_allowance() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
  CREATE TRIGGER trg_update_holiday_allowance AFTER UPDATE ON public.time_off_requests
    FOR EACH ROW EXECUTE FUNCTION public.update_holiday_allowance();

  GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.time_off_requests TO anon, authenticated;
  GRANT SELECT, INSERT, UPDATE, DELETE ON public.profiles, public.profile_locations, public.staff_allowances, public.locations TO authenticated;
  GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;

  CREATE FUNCTION private.auth_is_master() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
    SELECT EXISTS (SELECT 1 FROM public.profiles WHERE id = (SELECT auth.uid()) AND role = 'master')
  $$;
  CREATE FUNCTION private.auth_is_manager_at(p_location_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
    SELECT private.auth_is_master() OR EXISTS (
      SELECT 1 FROM public.profile_locations pl WHERE pl.profile_id = (SELECT auth.uid())
        AND pl.location_id = p_location_id AND pl.role IN ('owner','manager','head_coach'))
  $$;
  GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA private TO authenticated;

  ALTER TABLE public.time_off_requests ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.staff_allowances ENABLE ROW LEVEL SECURITY;

  -- The three live policies (mig 048/050 INSERT, mig 600 SELECT + UPDATE).
  CREATE POLICY "Staff can create own time off" ON public.time_off_requests
    FOR INSERT TO authenticated WITH CHECK (profile_id = (SELECT auth.uid()));
  CREATE POLICY "time_off_requests_select" ON public.time_off_requests FOR SELECT TO authenticated
    USING (profile_id = (SELECT auth.uid()) OR private.auth_is_manager_at(location_id));
  CREATE POLICY "time_off_requests_update" ON public.time_off_requests FOR UPDATE TO authenticated
    USING (private.auth_is_manager_at(location_id) OR (profile_id = (SELECT auth.uid()) AND status = 'pending'::text))
    WITH CHECK (private.auth_is_manager_at(location_id) OR status = 'cancelled'::text);
  CREATE POLICY "staff_allowances_all" ON public.staff_allowances FOR ALL TO authenticated USING (true) WITH CHECK (true);
`

const SEED = `
  INSERT INTO public.locations VALUES ('${LOC}');
  INSERT INTO public.profiles (id, role, full_name, employment_type) VALUES
    ('${MANAGER}', 'manager', 'Manager', 'fte'), ('${OWNER}', 'owner', 'Owner', 'fte'), ('${COACH}', 'staff', 'Coach', 'fte');
  INSERT INTO public.profile_locations VALUES
    ('${MANAGER}', '${LOC}', 'manager'), ('${OWNER}', '${LOC}', 'owner'), ('${COACH}', '${LOC}', 'staff');
  INSERT INTO public.staff_allowances (profile_id, year, total_days, used_days) VALUES ('${COACH}', 2026, 20, 2);
  INSERT INTO public.time_off_requests (id, profile_id, location_id, type, start_date, end_date, total_days, status, reviewed_by, reviewed_at) VALUES
    ('${COACH_LEAVE}', '${COACH}', '${LOC}', 'holiday', '2026-10-12', '2026-10-13', 2, 'approved', '${OWNER}', now());
`

let db

// PGlite's multi-statement SQL runner (PGlite#exec: a SQL call into the
// in-process Postgres, no shell and no child process), as in the 624 replay.
const runSql = (text) => db.exec(text)

/** Run `sql` as `role` with a JWT for `uid`, inside a rolled-back tx; returns rows. */
async function asUser(uid, sql, role = 'authenticated') {
  await runSql('BEGIN')
  try {
    await db.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: uid, role })])
    await runSql(`SET LOCAL ROLE ${role}`)
    return (await db.query(sql)).rows
  } finally {
    await runSql('ROLLBACK')
  }
}

async function rolledBack(fn) {
  await runSql('BEGIN')
  try { return await fn() } finally { await runSql('ROLLBACK') }
}

const usedDays = async (profileId) =>
  Number((await db.query(`SELECT used_days FROM public.staff_allowances WHERE profile_id = $1 AND year = 2026`, [profileId])).rows[0].used_days)

const forged = (profileId) => `INSERT INTO public.time_off_requests (profile_id, location_id, type, start_date, end_date, total_days, status, reviewed_by)
  VALUES ('${profileId}', '${LOC}', 'holiday', '2026-11-02', '2026-11-06', 5, 'approved', '${OWNER}') RETURNING status`

const browserPrivileges = async () => (await db.query(`
  SELECT grantee, privilege_type FROM information_schema.table_privileges
   WHERE table_schema='public' AND table_name='time_off_requests' AND grantee IN ('anon','authenticated','PUBLIC')
   ORDER BY 1, 2`)).rows.map((r) => `${r.grantee}:${r.privilege_type}`)

const policies = async () => (await db.query(`
  SELECT policyname, cmd FROM pg_policies WHERE schemaname='public' AND tablename='time_off_requests' ORDER BY 1`)).rows

beforeAll(async () => {
  db = new PGlite()
  await runSql(BASE_SCHEMA)
  await runSql(MIG_616)
  await runSql(SEED)
}, 60_000)

afterAll(async () => { await db?.close() })

describe('before 625: the browser INSERT door is real (guards against a vacuous pass)', () => {
  it('a coach\'s own JWT inserts their leave ALREADY APPROVED, and the allowance is not charged', async () => {
    await runSql('BEGIN')
    try {
      await db.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: COACH, role: 'authenticated' })])
      await runSql('SET LOCAL ROLE authenticated')
      expect((await db.query(forged(COACH))).rows).toEqual([{ status: 'approved' }])
      await runSql('RESET ROLE')
      // The trigger is AFTER UPDATE only: five approved holiday days, nothing charged.
      expect(await usedDays(COACH)).toBe(2)
    } finally {
      await runSql('ROLLBACK')
    }
  })

  it('...and only as themselves: the policy is the only thing checked', async () => {
    await expect(asUser(COACH, forged(MANAGER))).rejects.toThrow(/row-level security/)
  })
})

describe('the self-check aborts the WHOLE file when a write grant survives', () => {
  it('a grant made by another grantor outlives the REVOKE, the DO block raises, and nothing is applied', async () => {
    await runSql(`
      GRANT INSERT ON public.time_off_requests TO other_grantor WITH GRANT OPTION;
      SET ROLE other_grantor;
      GRANT INSERT ON public.time_off_requests TO authenticated;
      RESET ROLE;
    `)
    // The file is its own BEGIN ... COMMIT; the RAISE leaves it aborted.
    await expect(runSql(MIG_625)).rejects.toThrow(/mig 625: anon\/authenticated still hold write privileges.*INSERT \(grantor other_grantor\)/)
    await runSql('ROLLBACK')
    // Nothing applied: the owner's grants and the INSERT policy are as seeded.
    expect(await browserPrivileges()).toContain('anon:DELETE')
    expect((await policies()).map((p) => p.policyname)).toContain('Staff can create own time off')
    // Undo the stray grant so the real apply below starts from prod's shape.
    await runSql(`
      SET ROLE other_grantor;
      REVOKE INSERT ON public.time_off_requests FROM authenticated;
      RESET ROLE;
      REVOKE INSERT ON public.time_off_requests FROM other_grantor;
    `)
  })
})

describe('the self-check reads has_table_privilege too, so an INHERITED write privilege aborts the file', () => {
  it('authenticated as a member of a role holding INSERT: information_schema lists nothing for authenticated, the file still aborts', async () => {
    await runSql(`
      CREATE ROLE inherits_insert NOLOGIN;
      GRANT INSERT ON public.time_off_requests TO inherits_insert;
      GRANT inherits_insert TO authenticated;
    `)
    await expect(runSql(MIG_625)).rejects.toThrow(/mig 625: authenticated still holds INSERT on public.time_off_requests/)
    await runSql('ROLLBACK')
    expect((await policies()).map((p) => p.policyname)).toContain('Staff can create own time off')
    await runSql(`
      REVOKE inherits_insert FROM authenticated;
      REVOKE INSERT ON public.time_off_requests FROM inherits_insert;
      DROP ROLE inherits_insert;
    `)
  })
})

describe('after 624 + 625', () => {
  beforeAll(async () => {
    await runSql(MIG_624)
    await runSql(MIG_625)
  }, 60_000)

  it('anon and authenticated hold exactly SELECT, with no column-level write grant', async () => {
    expect(await browserPrivileges()).toEqual(['anon:SELECT', 'authenticated:SELECT'])
    const { rows } = await db.query(`
      SELECT count(*)::int AS n FROM information_schema.column_privileges
       WHERE table_schema='public' AND table_name='time_off_requests'
         AND grantee IN ('anon','authenticated','PUBLIC') AND privilege_type <> 'SELECT'`)
    expect(rows[0].n).toBe(0)
  })

  it('the INSERT policy and the grantless UPDATE policy are gone: exactly one SELECT policy remains', async () => {
    expect(await policies()).toEqual([{ policyname: 'time_off_requests_select', cmd: 'SELECT' }])
  })

  it('has_table_privilege (the real catalog, inherited roles included) agrees: SELECT only, for anon, authenticated and PUBLIC writes', async () => {
    const { rows } = await db.query(`
      SELECT r, p, has_table_privilege(r, 'public.time_off_requests', p) AS held
        FROM unnest(ARRAY['anon','authenticated','public']) r,
             unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p`)
    const held = rows.filter((x) => x.held).map((x) => `${x.r}:${x.p}`).sort()
    expect(held).toEqual(['anon:SELECT', 'authenticated:SELECT'])
  })

  it('the forged approved INSERT is refused, as are DELETE, TRUNCATE and UPDATE', async () => {
    await expect(asUser(COACH, forged(COACH))).rejects.toThrow(/permission denied/)
    await expect(asUser(COACH, forged(COACH), 'anon')).rejects.toThrow(/permission denied/)
    await expect(asUser(OWNER, `DELETE FROM public.time_off_requests WHERE id = '${COACH_LEAVE}'`)).rejects.toThrow(/permission denied/)
    await expect(asUser(OWNER, 'TRUNCATE public.time_off_requests')).rejects.toThrow(/permission denied/)
    await expect(asUser(MANAGER, `UPDATE public.time_off_requests SET status = 'cancelled' WHERE id = '${COACH_LEAVE}'`)).rejects.toThrow(/permission denied/)
    expect((await db.query(`SELECT count(*)::int AS n FROM public.time_off_requests`)).rows[0].n).toBe(1)
  })

  it('the browser still reads exactly the rows it could (the phone\'s dashboard read)', async () => {
    const mine = await asUser(COACH, `SELECT id, type, start_date, end_date, status, created_at FROM public.time_off_requests`)
    expect(mine.map((r) => r.id)).toEqual([COACH_LEAVE])
    expect((await asUser(MANAGER, `SELECT id FROM public.time_off_requests`)).map((r) => r.id)).toEqual([COACH_LEAVE])
  })

  it('service_role still inserts PENDING and approves it, and the approve charges the allowance (the POST\'s path)', async () => {
    await rolledBack(async () => {
      await runSql('SET LOCAL ROLE service_role')
      const { rows } = await db.query(`INSERT INTO public.time_off_requests (profile_id, location_id, type, start_date, end_date, total_days, status)
        VALUES ('${COACH}', '${LOC}', 'holiday', '2026-11-02', '2026-11-06', 5, 'pending') RETURNING id`)
      await db.query(`UPDATE public.time_off_requests SET status = 'approved', reviewed_by = '${OWNER}' WHERE id = $1`, [rows[0].id])
      await runSql('RESET ROLE')
      expect(await usedDays(COACH)).toBe(7)
    })
  })

  it('is re-runnable', async () => {
    await expect(runSql(MIG_625)).resolves.toBeDefined()
    expect(await browserPrivileges()).toEqual(['anon:SELECT', 'authenticated:SELECT'])
  })
})
