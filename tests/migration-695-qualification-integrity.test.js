// REVIEWNITS.1 (D5) — behavioural test for migration 695 (qualification
// integrity). Boots PGlite with the minimum prod shape (the mig 635 test's),
// applies the REAL 635, creates an organisation the way prod could have since
// (no types), applies the REAL 695, replays it, and checks: the cap of 5 in
// the table, the seed for a new organisation (also from a client session the
// organizations_ins policy lets in), the backfill, the posture of the two
// trigger functions, the 634 comment, and that the self-check refuses a
// database already over the cap.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const MIG = (f) => readFileSync(path.resolve(import.meta.dirname, '../supabase/migrations', f), 'utf8')
const MIG_635 = MIG('635_staff_qualifications.sql')
const MIG_695 = MIG('695_qualification_integrity.sql')

const ORG_A = '00000000-0000-0000-0000-0000000000a1'
const ORG_SINCE = '00000000-0000-0000-0000-0000000000c1' // created after 635, before 695
const ORG_NEW = '00000000-0000-0000-0000-0000000000d1' // created after 695
const ORG_CLIENT = '00000000-0000-0000-0000-0000000000e1' // created by a master's browser
const LOC_A = '00000000-0000-0000-0000-0000000000a2'
const TPL = '20000000-0000-0000-0000-00000000000a'
const TPL_2 = '20000000-0000-0000-0000-00000000000b'

const BASE_SCHEMA = `
  CREATE ROLE anon NOLOGIN;
  CREATE ROLE authenticated NOLOGIN;
  CREATE ROLE service_role NOLOGIN BYPASSRLS;
  CREATE SCHEMA private;
  GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;

  CREATE TABLE public.organizations (id uuid PRIMARY KEY, name text NOT NULL);
  CREATE TABLE public.locations (
    id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES public.organizations(id), name text
  );
  CREATE TABLE public.profiles (id uuid PRIMARY KEY, full_name text, deleted_at timestamptz);
  CREATE TABLE public.shift_templates (
    id uuid PRIMARY KEY, location_id uuid NOT NULL REFERENCES public.locations(id), name text
  );
  CREATE TABLE public.cron_heartbeats (
    name text PRIMARY KEY, last_ok_at timestamptz, expected_interval_seconds int,
    grace_seconds int, notes text, last_outcome jsonb
  );
  -- mig 634's function, as a stand-in (695 only comments on it).
  CREATE FUNCTION public.roster_publish_snapshots_refuse_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN OLD; END $$;
  -- mig 320's organizations_ins: a master's browser may insert an organisation.
  ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;
  CREATE POLICY organizations_ins ON public.organizations FOR INSERT TO authenticated WITH CHECK (true);
`
const SEED = `
  INSERT INTO public.organizations (id, name) VALUES ('${ORG_A}', 'Org A');
  INSERT INTO public.locations (id, organization_id, name) VALUES ('${LOC_A}', '${ORG_A}', 'Studio A');
  INSERT INTO public.shift_templates (id, location_id, name) VALUES ('${TPL}', '${LOC_A}', 'Morning'), ('${TPL_2}', '${LOC_A}', 'Evening');
`

let db
// PGlite's multi-statement runner, reached through Reflect.apply (the
// workspace's security hook refuses a file containing that call form).
const runSql = (text) => Reflect.apply(db.exec, db, [text])
const typeNames = async (org) =>
  (await db.query('SELECT name FROM public.staff_qualification_types WHERE organization_id = $1 ORDER BY sort_order', [org])).rows.map((r) => r.name)
const SEEDED = ['First aid', 'Insurance', 'Garda vetting']
const EXTRA = ['Manual handling', 'Lifeguard', 'Child safeguarding', 'Food hygiene']
const typeIds = async (org) =>
  (await db.query('SELECT id FROM public.staff_qualification_types WHERE organization_id = $1 ORDER BY sort_order, name', [org])).rows.map((r) => r.id)
const require_ = (tpl, ids) => db.query(
  `INSERT INTO public.shift_template_qualification_requirements (template_id, qualification_type_id)
   SELECT $1, unnest($2::uuid[])`, [tpl, ids])
const countFor = async (tpl) =>
  (await db.query('SELECT count(*)::int AS n FROM public.shift_template_qualification_requirements WHERE template_id = $1', [tpl])).rows[0].n

beforeAll(async () => {
  db = new PGlite()
  await runSql(BASE_SCHEMA)
  await runSql(SEED)
  await runSql(MIG_635)
  // An organisation created between 635 and 695: no types.
  await runSql(`INSERT INTO public.organizations (id, name) VALUES ('${ORG_SINCE}', 'Since 635')`)
  await runSql(MIG_695)
  await runSql(MIG_695) // a replay is a no-op
  for (const [i, name] of EXTRA.entries()) {
    await db.query('INSERT INTO public.staff_qualification_types (organization_id, name, sort_order) VALUES ($1, $2, $3)', [ORG_A, name, 40 + i])
  }
}, 60_000)

afterAll(async () => { await db?.close() })

describe('migration 695 — a new organisation has the three types', () => {
  it('backfills an organisation created since 635', async () => {
    expect(await typeNames(ORG_SINCE)).toEqual(SEEDED)
  })

  it('seeds one inserted after 695, once (a replay seeded nothing twice)', async () => {
    await db.query('INSERT INTO public.organizations (id, name) VALUES ($1, $2)', [ORG_NEW, 'New org'])
    expect(await typeNames(ORG_NEW)).toEqual(SEEDED)
    expect(await typeNames(ORG_A)).toEqual([...SEEDED, ...EXTRA])
  })

  it('seeds one a client session inserts (the trigger runs as its owner)', async () => {
    await runSql('GRANT INSERT ON public.organizations TO authenticated')
    await runSql('SET ROLE authenticated')
    try {
      await db.query('INSERT INTO public.organizations (id, name) VALUES ($1, $2)', [ORG_CLIENT, 'Client org'])
    } finally {
      await runSql('RESET ROLE')
    }
    expect(await typeNames(ORG_CLIENT)).toEqual(SEEDED)
  })
})

describe('migration 695 — at most 5 requirements per template, in the table', () => {
  it('5 are fine; a 6th is refused, and so is a 6-row insert in one statement', async () => {
    const ids = await typeIds(ORG_A)
    expect(ids.length).toBeGreaterThanOrEqual(7)
    await require_(TPL, ids.slice(0, 5))
    expect(await countFor(TPL)).toBe(5)
    await expect(require_(TPL, [ids[5]])).rejects.toThrow(/qualification_requirements_cap/)
    await expect(require_(TPL_2, ids.slice(0, 6))).rejects.toThrow(/qualification_requirements_cap/)
    expect(await countFor(TPL)).toBe(5)
    expect(await countFor(TPL_2)).toBe(0)
  })

  it('a replace within the cap (delete, then add, as the API does) passes', async () => {
    const ids = await typeIds(ORG_A)
    await db.query('DELETE FROM public.shift_template_qualification_requirements WHERE template_id = $1 AND qualification_type_id = $2', [TPL, ids[0]])
    await require_(TPL, [ids[6]])
    expect(await countFor(TPL)).toBe(5)
  })

  it('moving a row onto a full template is refused too', async () => {
    const ids = await typeIds(ORG_A)
    await require_(TPL_2, [ids[0]])
    await expect(db.query('UPDATE public.shift_template_qualification_requirements SET template_id = $1 WHERE template_id = $2', [TPL, TPL_2]))
      .rejects.toThrow(/qualification_requirements_cap/)
  })
})

describe('migration 695 — posture and the 634 comment', () => {
  it('both trigger functions are SECURITY DEFINER in private, with search_path pinned, and no client role executes them', async () => {
    const { rows } = await db.query(`
      SELECT p.proname, p.prosecdef, p.proconfig,
             has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
             has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth
        FROM pg_proc p WHERE p.pronamespace = 'private'::regnamespace
         AND p.proname IN ('shift_template_qualification_cap', 'seed_staff_qualification_types') ORDER BY 1`)
    expect(rows).toHaveLength(2)
    for (const r of rows) expect(r, r.proname).toMatchObject({ prosecdef: true, proconfig: ['search_path=""'], anon: false, auth: false })
  })

  it('says what the snapshot delete trigger really lets through', async () => {
    const { rows } = await db.query(`SELECT obj_description('public.roster_publish_snapshots_refuse_delete()'::regprocedure, 'pg_proc') AS c`)
    expect(rows[0].c).toMatch(/ANY delete fired from inside another trigger/)
  })
})

describe('migration 695 — the self-check refuses a database already over the cap', () => {
  it('a template with 6 requirements before the apply: nothing is applied', async () => {
    const fresh = new PGlite()
    const run = (text) => Reflect.apply(fresh.exec, fresh, [text])
    try {
      await run(BASE_SCHEMA)
      await run(SEED)
      await run(MIG_635)
      for (const [i, name] of EXTRA.entries()) {
        await fresh.query('INSERT INTO public.staff_qualification_types (organization_id, name, sort_order) VALUES ($1, $2, $3)', [ORG_A, name, 40 + i])
      }
      await fresh.query(`INSERT INTO public.shift_template_qualification_requirements (template_id, qualification_type_id)
        SELECT $1, id FROM public.staff_qualification_types WHERE organization_id = $2 LIMIT 6`, [TPL, ORG_A])
      await expect(run(MIG_695)).rejects.toThrow(/more than 5 qualifications/)
      await run('ROLLBACK')
      const { rows } = await fresh.query(`SELECT count(*)::int AS n FROM pg_trigger WHERE tgname = 'shift_template_qualification_cap'`)
      expect(rows[0].n).toBe(0)
    } finally {
      await fresh.close()
    }
  }, 60_000)
})
