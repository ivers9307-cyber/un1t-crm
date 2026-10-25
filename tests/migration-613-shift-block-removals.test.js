// SLOTREMOVAL.1 — behavioural RLS test for migration 613.
//
// Same approach as migration-614-coach-roster-read-scope.test.js: boot an
// in-process Postgres (PGlite), recreate the minimum tables and the prod
// helper functions the policies call, apply the real 613 file, and exercise
// the policies as authenticated JWTs. App code reaches this table only via the
// service role (RLS bypass); these policies fence a browser/mobile client.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const MIGRATION = readFileSync(
  path.resolve(import.meta.dirname, '../supabase/migrations/613_shift_block_removals.sql'),
  'utf8',
)

const LOC_A = 'a0000000-0000-0000-0000-00000000000a'
const LOC_B = 'b0000000-0000-0000-0000-00000000000b'
const MANAGER_A = '10000000-0000-0000-0000-000000000001' // manager at A
const STAFF_A = '10000000-0000-0000-0000-000000000002'   // staff at A
const MANAGER_B = '10000000-0000-0000-0000-000000000003' // manager at B only
const TPL_A = '40000000-0000-0000-0000-000000000001'
const TPL_A2 = '40000000-0000-0000-0000-000000000002'

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
  CREATE TABLE public.shift_templates (
    id uuid PRIMARY KEY, location_id uuid NOT NULL REFERENCES public.locations(id)
  );

  -- Helper functions, verbatim from prod (pg_get_functiondef, 17 Sep; same copy as the 614 test).
  CREATE FUNCTION private.auth_is_master() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
    SELECT EXISTS (SELECT 1 FROM public.profiles WHERE id = (SELECT auth.uid()) AND role = 'master')
  $$;
  CREATE FUNCTION private.auth_is_manager_at(p_location_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
    SELECT private.auth_is_master() OR EXISTS (
      SELECT 1 FROM public.profile_locations pl WHERE pl.profile_id = (SELECT auth.uid())
        AND pl.location_id = p_location_id AND pl.role IN ('owner','manager','head_coach'))
  $$;
  GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA private TO authenticated;
  -- Supabase's default privileges grant new public tables to both roles.
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO authenticated, anon;
`

const SEED = `
  INSERT INTO public.locations VALUES ('${LOC_A}'), ('${LOC_B}');
  INSERT INTO public.profiles VALUES ('${MANAGER_A}', 'manager'), ('${STAFF_A}', 'staff'), ('${MANAGER_B}', 'manager');
  INSERT INTO public.profile_locations VALUES
    ('${MANAGER_A}', '${LOC_A}', 'manager'), ('${STAFF_A}', '${LOC_A}', 'staff'), ('${MANAGER_B}', '${LOC_B}', 'manager');
  INSERT INTO public.shift_templates VALUES ('${TPL_A}', '${LOC_A}'), ('${TPL_A2}', '${LOC_A}');
  INSERT INTO public.shift_block_removals (location_id, template_id, block_date, removed_by)
    VALUES ('${LOC_A}', '${TPL_A}', '2026-09-11', '${MANAGER_A}');
`

let db
const runSql = (text) => db.exec(text)

/** Run `sql` as `role` (JWT sub `uid`) inside a rolled-back tx; returns { rows, affectedRows }. */
async function as(uid, sql, { role = 'authenticated' } = {}) {
  await runSql('BEGIN')
  try {
    await db.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: uid, role })])
    await runSql(`SET LOCAL ROLE ${role}`)
    const res = await db.query(sql)
    return { rows: res.rows, affectedRows: res.affectedRows ?? 0 }
  } finally {
    await runSql('ROLLBACK')
  }
}

const insertSql = (loc, tpl, date, by) => `INSERT INTO public.shift_block_removals (location_id, template_id, block_date, removed_by)
  VALUES ('${loc}', '${tpl}', '${date}', ${by ? `'${by}'` : 'NULL'})`

beforeAll(async () => {
  db = new PGlite()
  await runSql(BASE_SCHEMA)
  await runSql(MIGRATION)
  await runSql(SEED)
}, 60_000)

afterAll(async () => { await db?.close() })

describe('migration 613 — shift_block_removals', () => {
  it('has exactly SELECT / INSERT / DELETE, permissive, TO authenticated (no UPDATE, no FOR ALL)', async () => {
    const { rows } = await db.query(`
      SELECT cmd, permissive, roles::text AS roles FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'shift_block_removals' ORDER BY cmd`)
    expect(rows.map((r) => r.cmd)).toEqual(['DELETE', 'INSERT', 'SELECT'])
    for (const r of rows) {
      expect(r.permissive).toBe('PERMISSIVE')
      expect(r.roles).toBe('{authenticated}')
    }
  })

  it('a manager at the location can read, insert and delete', async () => {
    expect((await as(MANAGER_A, 'SELECT id FROM public.shift_block_removals')).rows).toHaveLength(1)
    await expect(as(MANAGER_A, insertSql(LOC_A, TPL_A, '2026-09-12', MANAGER_A))).resolves.toBeTruthy()
    const del = await as(MANAGER_A, `DELETE FROM public.shift_block_removals WHERE block_date = '2026-09-11'`)
    expect(del.affectedRows).toBe(1)
  })

  it('staff at the location can neither read, insert nor delete', async () => {
    expect((await as(STAFF_A, 'SELECT id FROM public.shift_block_removals')).rows).toHaveLength(0)
    await expect(as(STAFF_A, insertSql(LOC_A, TPL_A, '2026-09-12', null))).rejects.toThrow(/row-level security/)
    const del = await as(STAFF_A, 'DELETE FROM public.shift_block_removals')
    expect(del.affectedRows).toBe(0)
  })

  it('a manager at ANOTHER location is fenced out of this one', async () => {
    expect((await as(MANAGER_B, 'SELECT id FROM public.shift_block_removals')).rows).toHaveLength(0)
    await expect(as(MANAGER_B, insertSql(LOC_A, TPL_A, '2026-09-12', MANAGER_B))).rejects.toThrow(/row-level security/)
  })

  it('a manager cannot stamp someone else as removed_by', async () => {
    await expect(as(MANAGER_A, insertSql(LOC_A, TPL_A, '2026-09-12', STAFF_A))).rejects.toThrow(/row-level security/)
  })

  it('no one can UPDATE a removal (there is no UPDATE policy)', async () => {
    const upd = await as(MANAGER_A, `UPDATE public.shift_block_removals SET reason = 'x'`)
    expect(upd.affectedRows).toBe(0)
  })

  it('anon reads nothing', async () => {
    await expect(as(null, 'SELECT id FROM public.shift_block_removals', { role: 'anon' })).rejects.toThrow(/permission denied/)
  })

  it('one row per (location, template, date)', async () => {
    await expect(runSql(insertSql(LOC_A, TPL_A, '2026-09-11', null))).rejects.toThrow(/shift_block_removals_slot_key/)
  })

  it('cascades with its template', async () => {
    await runSql('BEGIN')
    try {
      await runSql(insertSql(LOC_A, TPL_A2, '2026-09-20', null))
      await runSql(`DELETE FROM public.shift_templates WHERE id = '${TPL_A2}'`)
      const { rows } = await db.query(`SELECT count(*)::int AS n FROM public.shift_block_removals WHERE template_id = '${TPL_A2}'`)
      expect(rows[0].n).toBe(0)
    } finally {
      await runSql('ROLLBACK')
    }
  })
})
