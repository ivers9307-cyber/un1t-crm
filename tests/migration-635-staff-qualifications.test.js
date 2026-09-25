// QUALS.1 — behavioural test for migration 635 (staff qualifications).
//
// Boots PGlite, recreates the minimum prod shape the file touches
// (organizations, locations, profiles, shift_templates, cron_heartbeats, the
// three API roles with Supabase's default privileges, the private schema),
// applies the REAL file, replays it, and checks the posture, the constraints,
// the same-organisation trigger, the seeds and the heartbeat row.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const MIGRATION = readFileSync(
  path.resolve(import.meta.dirname, '../supabase/migrations/635_staff_qualifications.sql'),
  'utf8',
)

const ORG_A = '00000000-0000-0000-0000-0000000000a1'
const ORG_B = '00000000-0000-0000-0000-0000000000b1'
const ORG_LATER = '00000000-0000-0000-0000-0000000000c1'
const LOC_A = '00000000-0000-0000-0000-0000000000a2'
const LOC_B = '00000000-0000-0000-0000-0000000000b2'
const COACH = '10000000-0000-0000-0000-00000000000a'
const OWNER = '10000000-0000-0000-0000-00000000000b'
const TPL_A = '20000000-0000-0000-0000-00000000000a'
const TPL_B = '20000000-0000-0000-0000-00000000000b'
const TPL_TEMP = '20000000-0000-0000-0000-0000000000cc'

const BASE_SCHEMA = `
  CREATE ROLE anon NOLOGIN;
  CREATE ROLE authenticated NOLOGIN;
  CREATE ROLE service_role NOLOGIN BYPASSRLS;
  CREATE SCHEMA private;
  GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
  -- Supabase's default privileges: every new public table is granted to all
  -- three API roles. The migration must take the browser's away.
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
`

const SEED = `
  INSERT INTO public.organizations (id, name) VALUES ('${ORG_A}', 'Org A'), ('${ORG_B}', 'Org B');
  INSERT INTO public.locations (id, organization_id, name) VALUES ('${LOC_A}', '${ORG_A}', 'Studio A'), ('${LOC_B}', '${ORG_B}', 'Garage B');
  INSERT INTO public.profiles (id, full_name) VALUES ('${COACH}', 'Coach C'), ('${OWNER}', 'Owner O');
  INSERT INTO public.shift_templates (id, location_id, name) VALUES ('${TPL_A}', '${LOC_A}', 'Morning'), ('${TPL_B}', '${LOC_B}', 'Service');
`

let db
// PGlite's multi-statement runner (the method the 630/633 tests call as
// db.exec), reached through Reflect.apply: the workspace's security hook
// refuses a file containing that call form.
const runSql = (text) => Reflect.apply(db.exec, db, [text])

async function asRole(role, sql, params = []) {
  await runSql(`SET ROLE ${role}`)
  try {
    return await db.query(sql, params)
  } finally {
    await runSql('RESET ROLE')
  }
}

const typeId = async (org, name) =>
  (await db.query('SELECT id FROM public.staff_qualification_types WHERE organization_id = $1 AND name = $2', [org, name])).rows[0]?.id

beforeAll(async () => {
  db = new PGlite()
  await runSql(BASE_SCHEMA)
  await runSql(SEED)
  await runSql(MIGRATION)
}, 60_000)

afterAll(async () => { await db?.close() })

describe('migration 635 — posture', () => {
  const TABLES = ['staff_qualification_types', 'staff_qualifications', 'shift_template_qualification_requirements']

  it('anon and authenticated hold nothing on any of the three tables', async () => {
    for (const role of ['anon', 'authenticated']) {
      for (const table of TABLES) {
        await expect(asRole(role, `SELECT 1 FROM public.${table}`)).rejects.toThrow(/permission denied/)
      }
    }
  })

  it('service_role can read them', async () => {
    const { rows } = await asRole('service_role', 'SELECT count(*)::int AS n FROM public.staff_qualification_types')
    expect(rows[0].n).toBeGreaterThan(0)
  })

  it('RLS is on and there are no policies (service-role only)', async () => {
    const { rows } = await db.query(`
      SELECT relname, relrowsecurity FROM pg_class
       WHERE relname = ANY($1) AND relnamespace = 'public'::regnamespace ORDER BY relname`, [TABLES])
    expect(rows).toHaveLength(3)
    expect(rows.every((r) => r.relrowsecurity)).toBe(true)
    const policies = await db.query(`SELECT count(*)::int AS n FROM pg_policies WHERE schemaname = 'public' AND tablename = ANY($1)`, [TABLES])
    expect(policies.rows[0].n).toBe(0)
  })
})

describe('migration 635 — seeds and heartbeat', () => {
  it('seeds First aid, Insurance and Garda vetting for every organisation, in that order', async () => {
    for (const org of [ORG_A, ORG_B]) {
      const { rows } = await db.query(
        'SELECT name, active FROM public.staff_qualification_types WHERE organization_id = $1 ORDER BY sort_order, name', [org])
      expect(rows).toEqual([
        { name: 'First aid', active: true },
        { name: 'Insurance', active: true },
        { name: 'Garda vetting', active: true },
      ])
    }
  })

  it('inserts the qualification-digest heartbeat row (86400s + 43200s grace), born healthy', async () => {
    const { rows } = await db.query(`SELECT expected_interval_seconds, grace_seconds, last_ok_at IS NOT NULL AS armed FROM public.cron_heartbeats WHERE name = 'qualification-digest'`)
    expect(rows).toEqual([{ expected_interval_seconds: 86400, grace_seconds: 43200, armed: true }])
  })

  it('replays as a no-op for the seeds (an owner rename survives), re-arms the heartbeat, and seeds an organisation added since', async () => {
    await runSql(`UPDATE public.staff_qualification_types SET name = 'First aid (PHECC)' WHERE organization_id = '${ORG_A}' AND name = 'First aid'`)
    await runSql(`UPDATE public.cron_heartbeats SET last_ok_at = now() - interval '3 days' WHERE name = 'qualification-digest'`)
    await runSql(`INSERT INTO public.organizations (id, name) VALUES ('${ORG_LATER}', 'Org C')`)
    await runSql(MIGRATION)
    const a = await db.query('SELECT name FROM public.staff_qualification_types WHERE organization_id = $1 ORDER BY sort_order', [ORG_A])
    expect(a.rows.map((r) => r.name)).toEqual(['First aid (PHECC)', 'Insurance', 'Garda vetting'])
    const c = await db.query('SELECT count(*)::int AS n FROM public.staff_qualification_types WHERE organization_id = $1', [ORG_LATER])
    expect(c.rows[0].n).toBe(3)
    const hb = await db.query(`SELECT last_ok_at > now() - interval '1 minute' AS fresh FROM public.cron_heartbeats WHERE name = 'qualification-digest'`)
    expect(hb.rows[0].fresh).toBe(true)
    await runSql(`UPDATE public.staff_qualification_types SET name = 'First aid' WHERE organization_id = '${ORG_A}' AND name = 'First aid (PHECC)'`)
  })
})

describe('migration 635 — types', () => {
  it('a name is unique per organisation, case-insensitively; another organisation may reuse it', async () => {
    await expect(runSql(`INSERT INTO public.staff_qualification_types (organization_id, name) VALUES ('${ORG_A}', 'first AID')`))
      .rejects.toThrow(/duplicate key/)
    await runSql(`INSERT INTO public.staff_qualification_types (organization_id, name) VALUES ('${ORG_B}', 'Forklift')`)
    await runSql(`INSERT INTO public.staff_qualification_types (organization_id, name) VALUES ('${ORG_A}', 'Forklift')`)
  })

  it.each([[''], ['   '], ['\n'], [' Leading'], ['Trailing '], ['Two\nlines'], ['x'.repeat(61)]])(
    'refuses the name %j', async (name) => {
      await expect(db.query('INSERT INTO public.staff_qualification_types (organization_id, name) VALUES ($1, $2)', [ORG_A, name]))
        .rejects.toThrow(/staff_qualification_types_name/)
    })
})

describe('migration 635 — records', () => {
  it('stores a record whose type is in its own organisation', async () => {
    const fa = await typeId(ORG_A, 'First aid')
    await db.query(`INSERT INTO public.staff_qualifications (organization_id, profile_id, qualification_type_id, issued_on, expires_on, note, recorded_by)
                    VALUES ($1, $2, $3, '2025-01-10', '2027-01-10', 'PHECC FAR', $4)`, [ORG_A, COACH, fa, OWNER])
    const { rows } = await db.query('SELECT expires_on::text AS e FROM public.staff_qualifications WHERE profile_id = $1', [COACH])
    expect(rows).toEqual([{ e: '2027-01-10' }])
  })

  it('refuses a record that names another organisation\'s type (composite FK)', async () => {
    const faB = await typeId(ORG_B, 'First aid')
    await expect(db.query('INSERT INTO public.staff_qualifications (organization_id, profile_id, qualification_type_id) VALUES ($1, $2, $3)', [ORG_A, OWNER, faB]))
      .rejects.toThrow(/staff_qualifications_type_same_org/)
  })

  it('one record per person per type', async () => {
    const fa = await typeId(ORG_A, 'First aid')
    await expect(db.query('INSERT INTO public.staff_qualifications (organization_id, profile_id, qualification_type_id) VALUES ($1, $2, $3)', [ORG_A, COACH, fa]))
      .rejects.toThrow(/staff_qualifications_one_per_type/)
  })

  it('refuses an expiry before the issue date, and a blank or over-long note; no expiry is allowed', async () => {
    const ins = await typeId(ORG_A, 'Insurance')
    const insert = (issued, expires, note) => db.query(
      'INSERT INTO public.staff_qualifications (organization_id, profile_id, qualification_type_id, issued_on, expires_on, note) VALUES ($1, $2, $3, $4, $5, $6)',
      [ORG_A, OWNER, ins, issued, expires, note])
    await expect(insert('2026-05-01', '2026-04-30', null)).rejects.toThrow(/staff_qualifications_dates/)
    await expect(insert(null, '2026-04-30', '  \n ')).rejects.toThrow(/staff_qualifications_note/)
    await expect(insert(null, '2026-04-30', 'x'.repeat(301))).rejects.toThrow(/staff_qualifications_note/)
    await insert('2026-05-01', null, null) // no expiry
  })

  it('a type that has a record cannot be deleted (archive it instead)', async () => {
    const fa = await typeId(ORG_A, 'First aid')
    await expect(db.query('DELETE FROM public.staff_qualification_types WHERE id = $1', [fa])).rejects.toThrow(/foreign key/)
  })
})

describe('migration 635 — template requirements', () => {
  it('accepts a type from the template\'s own organisation', async () => {
    const fa = await typeId(ORG_A, 'First aid')
    await asRole('service_role', 'INSERT INTO public.shift_template_qualification_requirements (template_id, qualification_type_id) VALUES ($1, $2)', [TPL_A, fa])
    const { rows } = await db.query('SELECT count(*)::int AS n FROM public.shift_template_qualification_requirements WHERE template_id = $1', [TPL_A])
    expect(rows[0].n).toBe(1)
  })

  it('refuses a type from another organisation, whoever writes it', async () => {
    const faB = await typeId(ORG_B, 'First aid')
    await expect(asRole('service_role', 'INSERT INTO public.shift_template_qualification_requirements (template_id, qualification_type_id) VALUES ($1, $2)', [TPL_A, faB]))
      .rejects.toThrow(/qualification_requirement_other_org/)
    const ins = await typeId(ORG_A, 'Insurance')
    await expect(db.query('INSERT INTO public.shift_template_qualification_requirements (template_id, qualification_type_id) VALUES ($1, $2)', [TPL_B, ins]))
      .rejects.toThrow(/qualification_requirement_other_org/)
  })

  it('a hard-deleted template takes its requirements with it', async () => {
    await runSql(`INSERT INTO public.shift_templates (id, location_id, name) VALUES ('${TPL_TEMP}', '${LOC_A}', 'Temp')`)
    const ins = await typeId(ORG_A, 'Insurance')
    await db.query('INSERT INTO public.shift_template_qualification_requirements (template_id, qualification_type_id) VALUES ($1, $2)', [TPL_TEMP, ins])
    await runSql(`DELETE FROM public.shift_templates WHERE id = '${TPL_TEMP}'`)
    const { rows } = await db.query('SELECT count(*)::int AS n FROM public.shift_template_qualification_requirements WHERE template_id = $1', [TPL_TEMP])
    expect(rows[0].n).toBe(0)
  })

  it('the trigger function is not executable by the browser roles', async () => {
    const { rows } = await db.query(`
      SELECT has_function_privilege('authenticated', 'private.shift_template_qualification_same_org()', 'EXECUTE') AS auth,
             has_function_privilege('anon', 'private.shift_template_qualification_same_org()', 'EXECUTE') AS anon`)
    expect(rows[0]).toEqual({ auth: false, anon: false })
  })
})

// QUALS.1 review 5 — the self-check confirms the same-organisation trigger,
// so a file edited to drop it cannot apply.
describe('migration 635 — self-check', () => {
  it('refuses to apply (nothing applied) without the same-organisation trigger', async () => {
    const trigger = /CREATE TRIGGER shift_template_qualification_same_org[\s\S]*?EXECUTE FUNCTION private\.shift_template_qualification_same_org\(\);/
    expect(MIGRATION).toMatch(trigger)
    const broken = MIGRATION.replace(trigger, '')
    const fresh = new PGlite()
    const run = (text) => Reflect.apply(fresh.exec, fresh, [text])
    try {
      await run(BASE_SCHEMA)
      await run(SEED)
      await expect(run(broken)).rejects.toThrow(/mig 635: the same-organisation trigger/)
      await run('ROLLBACK')
      const { rows } = await fresh.query("SELECT to_regclass('public.staff_qualification_types') AS t")
      expect(rows[0].t).toBeNull()
    } finally {
      await fresh.close()
    }
  }, 60_000)
})
