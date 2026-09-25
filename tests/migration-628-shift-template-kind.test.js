// SHIFTTYPE.1 — behavioural test for migration 628.
//
// Same reason as the 613/618/622/624/625 replays: there is no local Supabase
// stack, so without this the DDL would get its first execution on prod. Boots
// PGlite, recreates shift_templates with the columns and CHECKs migs
// 010/067/177 left it and the table-level grants prod has, applies the real
// 628 file, and proves the header's claims.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const MIG_628 = readFileSync(
  path.resolve(import.meta.dirname, '../supabase/migrations/628_shift_template_kind.sql'),
  'utf8',
)

const LOC = 'a0000000-0000-0000-0000-00000000000a'
const TPL_CLASS = '40000000-0000-0000-0000-000000000001'
const TPL_ZERO = '40000000-0000-0000-0000-000000000002'

// shift_templates as migs 010 + 067 + 177 left it (only what 628 touches or
// must coexist with), with Supabase's default table-level grants.
const BASE_SCHEMA = `
  CREATE ROLE anon NOLOGIN;
  CREATE ROLE authenticated NOLOGIN;
  CREATE ROLE service_role NOLOGIN BYPASSRLS;
  CREATE TABLE public.locations (id uuid PRIMARY KEY);
  CREATE TABLE public.shift_templates (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
    name text NOT NULL,
    start_time time NOT NULL,
    end_time time NOT NULL,
    active boolean DEFAULT true,
    days_of_week text[] NOT NULL DEFAULT '{}'::text[],
    max_coaches smallint NOT NULL DEFAULT 15,
    min_coaches smallint NOT NULL DEFAULT 1,
    UNIQUE (location_id, name),
    CONSTRAINT shift_templates_max_coaches_check CHECK (max_coaches BETWEEN 1 AND 50),
    CONSTRAINT shift_templates_min_coaches_check CHECK (min_coaches >= 0 AND min_coaches <= max_coaches)
  );
  GRANT SELECT, INSERT, UPDATE, DELETE ON public.shift_templates TO anon, authenticated;
  GRANT ALL ON public.shift_templates TO service_role;
`

const SEED = `
  INSERT INTO public.locations VALUES ('${LOC}');
  INSERT INTO public.shift_templates (id, location_id, name, start_time, end_time, min_coaches, max_coaches) VALUES
    ('${TPL_CLASS}', '${LOC}', 'Morning', '06:00', '07:00', 2, 10),
    ('${TPL_ZERO}',  '${LOC}', 'Consultation', '09:00', '10:00', 0, 3);
`

async function boot({ before = '' } = {}) {
  const pg = new PGlite()
  await pg.exec(BASE_SCHEMA)
  await pg.exec(SEED)
  if (before) await pg.exec(before)
  return pg
}

const insertTpl = (name, kind, min) => `INSERT INTO public.shift_templates
  (location_id, name, start_time, end_time, max_coaches, min_coaches${kind ? ', kind' : ''})
  VALUES ('${LOC}', '${name}', '12:00', '13:00', 5, ${min}${kind ? `, '${kind}'` : ''})`

const KIND_CONSTRAINTS = `SELECT conname FROM pg_constraint
  WHERE conrelid = 'public.shift_templates'::regclass
    AND conname IN ('shift_templates_kind_check', 'shift_templates_admin_no_minimum')
  ORDER BY 1`

let db
beforeAll(async () => {
  db = await boot()
  await db.exec(MIG_628)
}, 60_000)

afterAll(async () => { await db?.close() })

describe('migration 628 — shift_templates.kind', () => {
  it("every existing template reads class: no backfill, today's behaviour exactly", async () => {
    const { rows } = await db.query('SELECT name, kind FROM public.shift_templates ORDER BY name')
    expect(rows).toEqual([{ name: 'Consultation', kind: 'class' }, { name: 'Morning', kind: 'class' }])
  })

  it('is NOT NULL text defaulting to class, so a writer that never heard of it creates a class template', async () => {
    const { rows } = await db.query(`SELECT data_type, is_nullable, column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'shift_templates' AND column_name = 'kind'`)
    expect(rows).toEqual([{ data_type: 'text', is_nullable: 'NO', column_default: "'class'::text" }])
    await db.exec('BEGIN')
    try {
      const r = await db.query(`${insertTpl('No kind', null, 1)} RETURNING kind`)
      expect(r.rows).toEqual([{ kind: 'class' }])
    } finally {
      await db.exec('ROLLBACK')
    }
  })

  it('refuses a kind that is neither class nor admin', async () => {
    await expect(db.exec(insertTpl('Bad', 'desk', 0))).rejects.toThrow(/shift_templates_kind_check/)
  })

  it('refuses an admin template with a minimum, on INSERT and on UPDATE', async () => {
    await expect(db.exec(insertTpl('Admin with min', 'admin', 1))).rejects.toThrow(/shift_templates_admin_no_minimum/)
    await expect(db.exec(`UPDATE public.shift_templates SET kind = 'admin' WHERE id = '${TPL_CLASS}'`))
      .rejects.toThrow(/shift_templates_admin_no_minimum/)
  })

  it('accepts admin at minimum 0, and a switch that writes both columns in ONE statement (what the API sends)', async () => {
    await db.exec('BEGIN')
    try {
      await db.exec(insertTpl('Admin block', 'admin', 0))
      await db.exec(`UPDATE public.shift_templates SET kind = 'admin', min_coaches = 0 WHERE id = '${TPL_CLASS}'`)
      await expect(db.exec(`UPDATE public.shift_templates SET min_coaches = 1 WHERE id = '${TPL_CLASS}'`))
        .rejects.toThrow(/shift_templates_admin_no_minimum/)
    } finally {
      await db.exec('ROLLBACK')
    }
  })

  it('a class template keeps any minimum, 0 included', async () => {
    await db.exec('BEGIN')
    try {
      await db.exec(insertTpl('Class zero', 'class', 0))
      await db.exec(insertTpl('Class three', 'class', 3))
    } finally {
      await db.exec('ROLLBACK')
    }
  })

  it('changes no grant: the column rides the table-level grants every other column has', async () => {
    const { rows } = await db.query(`SELECT
      has_column_privilege('authenticated', 'public.shift_templates', 'kind', 'SELECT') AS auth_select,
      has_column_privilege('authenticated', 'public.shift_templates', 'kind', 'UPDATE') AS auth_update,
      has_column_privilege('service_role',  'public.shift_templates', 'kind', 'UPDATE') AS svc_update`)
    expect(rows[0]).toEqual({ auth_select: true, auth_update: true, svc_update: true })
  })

  it('re-running the file is a no-op', async () => {
    await db.exec(MIG_628)
    expect((await db.query(KIND_CONSTRAINTS)).rows.map((r) => r.conname))
      .toEqual(['shift_templates_admin_no_minimum', 'shift_templates_kind_check'])
  })
})

describe('the self-check aborts the WHOLE file', () => {
  it('when a nullable kind column already exists, ADD COLUMN IF NOT EXISTS keeps it, the DO block raises, nothing is applied', async () => {
    const other = await boot({ before: 'ALTER TABLE public.shift_templates ADD COLUMN kind text' })
    try {
      // The file is its own BEGIN ... COMMIT; the RAISE leaves it aborted.
      await expect(other.exec(MIG_628)).rejects.toThrow(/mig 628: shift_templates\.kind has the wrong shape/)
      await other.exec('ROLLBACK')
      expect((await other.query(KIND_CONSTRAINTS)).rows).toEqual([])
    } finally {
      await other.close()
    }
  })
})
