// CONTRACTVIS.1 — behavioural RLS test for migration 643.
//
// Boots an in-process Postgres (PGlite) with the minimum the generated_reports
// policies touch: the tables, the mig-626 helper functions (active + not
// tombstoned) and the four policies exactly as mig 614 left them (checked
// against prod pg_policies on 27 Sep). It proves the leak (a head coach's JWT
// reads staff_cost and utilisation rows), applies the REAL 643 file, and then
// asserts, per command, who may touch which report type. It also pins the
// migration's type list to RATE_REPORT_TYPES, and proves the self-check
// aborts the whole file when a policy is not narrowed.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { RATE_REPORT_TYPES } from '@/lib/report-access'
import { reportTypeSchema } from '@/lib/schemas'

const MIG_643 = readFileSync(
  path.resolve(import.meta.dirname, '../supabase/migrations/643_contractvis_generated_reports_rls.sql'),
  'utf8',
)

const LOC_A = 'a0000000-0000-0000-0000-00000000000a'
const LOC_B = 'b0000000-0000-0000-0000-00000000000b'

const OWNER_A = '10000000-0000-0000-0000-000000000001'
const MANAGER_A = '10000000-0000-0000-0000-000000000002'
const HEAD_COACH_A = '10000000-0000-0000-0000-000000000003'
const STAFF_A = '10000000-0000-0000-0000-000000000004'
const MASTER = '10000000-0000-0000-0000-000000000005'
const MIXED = '10000000-0000-0000-0000-000000000006'        // manager at A, head_coach at B
const INACTIVE_MANAGER_A = '10000000-0000-0000-0000-000000000007'

const ALL_TYPES = [...reportTypeSchema.options].sort()
const ADMIN_ONLY = ['staff_cost', 'utilisation']
const OTHERS = ALL_TYPES.filter((t) => !ADMIN_ONLY.includes(t))

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
    id uuid PRIMARY KEY, role text NOT NULL, active boolean DEFAULT true, deleted_at timestamptz
  );
  CREATE TABLE public.profile_locations (
    profile_id uuid REFERENCES public.profiles(id),
    location_id uuid REFERENCES public.locations(id),
    role text NOT NULL,
    PRIMARY KEY (profile_id, location_id)
  );
  CREATE TABLE public.generated_reports (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id uuid NOT NULL REFERENCES public.locations(id),
    report_type text NOT NULL,
    report_name text NOT NULL DEFAULT 'r'
  );

  GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated;

  -- Helpers as mig 626 left them (active, not tombstoned).
  CREATE FUNCTION private.auth_is_admin_at(p_location_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
    SELECT EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = (SELECT auth.uid()) AND p.active IS NOT FALSE AND p.deleted_at IS NULL
        AND (p.role = 'master' OR EXISTS (
          SELECT 1 FROM public.profile_locations pl
          WHERE pl.profile_id = (SELECT auth.uid()) AND pl.location_id = p_location_id
            AND pl.role IN ('owner','manager'))))
  $$;
  CREATE FUNCTION private.auth_is_manager_at(p_location_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
    SELECT EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = (SELECT auth.uid()) AND p.active IS NOT FALSE AND p.deleted_at IS NULL
        AND (p.role = 'master' OR EXISTS (
          SELECT 1 FROM public.profile_locations pl
          WHERE pl.profile_id = (SELECT auth.uid()) AND pl.location_id = p_location_id
            AND pl.role IN ('owner','manager','head_coach'))))
  $$;
  GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA private TO authenticated;

  ALTER TABLE public.generated_reports ENABLE ROW LEVEL SECURITY;
`

// The four policies as mig 614 created them (prod pg_policies, 27 Sep).
const POLICIES_614 = `
  CREATE POLICY "generated_reports_select" ON public.generated_reports
    FOR SELECT TO authenticated USING (private.auth_is_manager_at(location_id));
  CREATE POLICY "generated_reports_ins" ON public.generated_reports
    FOR INSERT TO authenticated WITH CHECK (private.auth_is_manager_at(location_id));
  CREATE POLICY "generated_reports_upd" ON public.generated_reports
    FOR UPDATE TO authenticated
    USING (private.auth_is_manager_at(location_id)) WITH CHECK (private.auth_is_manager_at(location_id));
  CREATE POLICY "generated_reports_del" ON public.generated_reports
    FOR DELETE TO authenticated USING (private.auth_is_manager_at(location_id));
`

const SEED = `
  INSERT INTO public.locations VALUES ('${LOC_A}'), ('${LOC_B}');
  INSERT INTO public.profiles (id, role, active) VALUES
    ('${OWNER_A}', 'owner', true), ('${MANAGER_A}', 'manager', true), ('${HEAD_COACH_A}', 'head_coach', true),
    ('${STAFF_A}', 'staff', true), ('${MASTER}', 'master', true), ('${MIXED}', 'manager', true),
    ('${INACTIVE_MANAGER_A}', 'manager', false);
  INSERT INTO public.profile_locations VALUES
    ('${OWNER_A}', '${LOC_A}', 'owner'), ('${MANAGER_A}', '${LOC_A}', 'manager'),
    ('${HEAD_COACH_A}', '${LOC_A}', 'head_coach'), ('${STAFF_A}', '${LOC_A}', 'staff'),
    ('${MIXED}', '${LOC_A}', 'manager'), ('${MIXED}', '${LOC_B}', 'head_coach'),
    ('${INACTIVE_MANAGER_A}', '${LOC_A}', 'manager');
  INSERT INTO public.generated_reports (location_id, report_type)
    SELECT l, t FROM unnest(ARRAY['${LOC_A}', '${LOC_B}']::uuid[]) l,
                     unnest(ARRAY[${ALL_TYPES.map((t) => `'${t}'`).join(', ')}]) t;
`

let db
// PGlite's multi-statement SQL runner (a database call, no shell involved).
const runSql = (text) => db.exec(text)

/** Run `sql` as an authenticated JWT for `uid` inside a rolled-back tx. */
async function asUser(uid, sql, params = []) {
  await runSql('BEGIN')
  try {
    await db.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: uid, role: 'authenticated' })])
    await runSql('SET LOCAL ROLE authenticated')
    return await db.query(sql, params)
  } finally {
    await runSql('ROLLBACK')
  }
}

/** { A|B: sorted report types } the user can SELECT. */
async function visible(uid) {
  const { rows } = await asUser(uid, 'SELECT location_id, report_type FROM public.generated_reports ORDER BY 1, 2')
  const out = {}
  for (const r of rows) (out[r.location_id === LOC_A ? 'A' : 'B'] ||= []).push(r.report_type)
  return out
}

const insertAs = (uid, loc, type) => asUser(uid, 'INSERT INTO public.generated_reports (location_id, report_type) VALUES ($1, $2)', [loc, type])
const updatedAs = async (uid, loc, type) => (await asUser(uid, `UPDATE public.generated_reports SET report_name = 'x' WHERE location_id = $1 AND report_type = $2`, [loc, type])).affectedRows
const deletedAs = async (uid, loc, type) => (await asUser(uid, 'DELETE FROM public.generated_reports WHERE location_id = $1 AND report_type = $2', [loc, type])).affectedRows

beforeEach(async () => {
  db = new PGlite()
  await runSql(BASE_SCHEMA)
  await runSql(POLICIES_614)
  await runSql(SEED)
}, 60_000)

afterEach(async () => { await db?.close() })

describe('mig 643 names exactly the admin-only report types the app gates', () => {
  it('the SQL type list equals RATE_REPORT_TYPES, in every clause', () => {
    expect([...RATE_REPORT_TYPES].sort()).toEqual(ADMIN_ONLY)
    const code = MIG_643.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')
    const lists = [...code.matchAll(/report_type NOT IN \(([^)]*)\)/g)]
      .map((m) => m[1].split(',').map((s) => s.trim().replace(/'/g, '')).sort())
    // select, ins, upd USING, upd WITH CHECK, del
    expect(lists).toHaveLength(5)
    for (const l of lists) expect(l).toEqual([...RATE_REPORT_TYPES].sort())
  })
})

describe('before 643 — the leak is real (guards against a vacuous pass)', () => {
  it('a head coach reads staff_cost and utilisation at their studio', async () => {
    expect((await visible(HEAD_COACH_A)).A).toEqual(ALL_TYPES)
  })
})

describe('after 643 — SELECT', () => {
  beforeEach(async () => { await runSql(MIG_643) })

  it('a head coach reads every other type at their studio, and neither admin-only one', async () => {
    expect(await visible(HEAD_COACH_A)).toEqual({ A: OTHERS })
  })

  for (const [label, uid] of [['owner', OWNER_A], ['manager', MANAGER_A]]) {
    it(`${label} at A reads every type at A, nothing at B`, async () => {
      expect(await visible(uid)).toEqual({ A: ALL_TYPES })
    })
  }

  it('master reads every type everywhere', async () => {
    expect(await visible(MASTER)).toEqual({ A: ALL_TYPES, B: ALL_TYPES })
  })

  it('manager at A, head coach at B: everything at A, the non-admin types at B', async () => {
    expect(await visible(MIXED)).toEqual({ A: ALL_TYPES, B: OTHERS })
  })

  it('staff and a deactivated manager read nothing (unchanged)', async () => {
    expect(await visible(STAFF_A)).toEqual({})
    expect(await visible(INACTIVE_MANAGER_A)).toEqual({})
  })
})

describe('after 643 — INSERT / UPDATE / DELETE', () => {
  beforeEach(async () => { await runSql(MIG_643) })

  it('a head coach cannot insert an admin-only type, and still can the others', async () => {
    for (const t of ADMIN_ONLY) await expect(insertAs(HEAD_COACH_A, LOC_A, t)).rejects.toThrow(/row-level security/)
    await expect(insertAs(HEAD_COACH_A, LOC_A, 'staff_hours')).resolves.toBeTruthy()
  })

  it('a manager can insert an admin-only type at their studio', async () => {
    await expect(insertAs(MANAGER_A, LOC_A, 'utilisation')).resolves.toBeTruthy()
  })

  it('a head coach updates and deletes no admin-only row; other rows as before', async () => {
    for (const t of ADMIN_ONLY) {
      expect(await updatedAs(HEAD_COACH_A, LOC_A, t)).toBe(0)
      expect(await deletedAs(HEAD_COACH_A, LOC_A, t)).toBe(0)
    }
    expect(await updatedAs(HEAD_COACH_A, LOC_A, 'staff_hours')).toBe(1)
    expect(await deletedAs(HEAD_COACH_A, LOC_A, 'staff_hours')).toBe(1)
  })

  it('a head coach cannot re-type a row INTO an admin-only type (UPDATE WITH CHECK)', async () => {
    await expect(asUser(HEAD_COACH_A, `UPDATE public.generated_reports SET report_type = 'utilisation' WHERE location_id = $1 AND report_type = 'staff_hours'`, [LOC_A]))
      .rejects.toThrow(/row-level security/)
  })

  it('the mixed person manages admin-only rows at A, not at B', async () => {
    expect(await updatedAs(MIXED, LOC_A, 'staff_cost')).toBe(1)
    expect(await updatedAs(MIXED, LOC_B, 'staff_cost')).toBe(0)
  })
})

describe('mig 643 — the file itself', () => {
  it('replays cleanly (DROP IF EXISTS then CREATE)', async () => {
    await runSql(MIG_643)
    await runSql(MIG_643)
    expect(await visible(HEAD_COACH_A)).toEqual({ A: OTHERS })
  })

  it('leaves exactly four permissive policies, one per command', async () => {
    await runSql(MIG_643)
    const { rows } = await db.query(`SELECT policyname, permissive, cmd FROM pg_policies WHERE tablename = 'generated_reports' ORDER BY policyname`)
    expect(rows).toEqual([
      { policyname: 'generated_reports_del', permissive: 'PERMISSIVE', cmd: 'DELETE' },
      { policyname: 'generated_reports_ins', permissive: 'PERMISSIVE', cmd: 'INSERT' },
      { policyname: 'generated_reports_select', permissive: 'PERMISSIVE', cmd: 'SELECT' },
      { policyname: 'generated_reports_upd', permissive: 'PERMISSIVE', cmd: 'UPDATE' },
    ])
  })

  it('the self-check aborts the WHOLE file when one policy is not narrowed', async () => {
    // Break only the DELETE policy: it keeps the 614 predicate.
    const broken = MIG_643.replace(
      /(CREATE POLICY "generated_reports_del"[\s\S]*?USING \()[\s\S]*?(\n  \);)/,
      '$1\n    private.auth_is_manager_at(location_id)$2',
    )
    expect(broken).not.toBe(MIG_643)
    await expect(runSql(broken)).rejects.toThrow(/expected exactly 4 narrowed generated_reports policies/)
    await runSql('ROLLBACK')
    // Nothing landed: the head coach still reads every type (the 614 state).
    expect((await visible(HEAD_COACH_A)).A).toEqual(ALL_TYPES)
  })

  it('the self-check aborts when an extra policy exists on the table', async () => {
    await runSql(`CREATE POLICY "stray" ON public.generated_reports FOR SELECT TO authenticated USING (true)`)
    await expect(runSql(MIG_643)).rejects.toThrow(/found 4 narrowed of 5 total/)
    await runSql('ROLLBACK')
  })
})
