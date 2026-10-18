// WAORGNUMBER.2 — behavioural test for migration 746: the three hatch_* templates
// move from Stillorgan to Hatch, and nothing else does. Loads the REAL 746 file
// into PGlite. Fictional ids only (the repo is public); the file names the three
// real template row ids, so the test rewrites them to fictional ones before running.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const MIG_746 = readFileSync(path.resolve(import.meta.dirname, '../supabase/migrations/746_move_hatch_templates.sql'), 'utf8')

const REAL = [
  'd67d6570-f64b-4d5c-8e19-fe3729f29c3d',
  '9118c478-5958-4655-9737-8e5c33bcc0fc',
  'a0e011b2-67a2-4121-833b-fa867ee8b8bf',
]
const FAKE = [
  'e0000000-0000-0000-0000-000000000001',
  'e0000000-0000-0000-0000-000000000002',
  'e0000000-0000-0000-0000-000000000003',
]
const OTHER_HATCH = 'e0000000-0000-0000-0000-000000000009' // a hatch_* name, but not one of the three ids
const NOT_HATCH = 'e0000000-0000-0000-0000-00000000000a' // an ordinary Stillorgan template
const STILL = 'a0000000-0000-0000-0000-000000000001'
const HATCH = 'a0000000-0000-0000-0000-000000000002'

// The migration with the real ids swapped for the fictional ones.
const MIG = REAL.reduce((sql, id, i) => sql.split(id).join(FAKE[i]), MIG_746)

const SCHEMA = `
  CREATE TABLE public.locations (id uuid PRIMARY KEY, name text NOT NULL);
  CREATE TABLE public.whatsapp_templates (id uuid PRIMARY KEY, location_id uuid REFERENCES public.locations(id),
    name text NOT NULL, business_account_id text, meta_template_id text);
  INSERT INTO public.locations VALUES ('${STILL}', 'UN1T Stillorgan'), ('${HATCH}', 'UN1T Hatch Street');
`
const SEED = `
  INSERT INTO public.whatsapp_templates (id, location_id, name, business_account_id, meta_template_id) VALUES
    ('${FAKE[0]}', '${STILL}', 'hatch_3_free_classes',      '100000000000001', 'm1'),
    ('${FAKE[1]}', '${STILL}', 'hatch_book_your_week',      '100000000000001', 'm2'),
    ('${FAKE[2]}', '${STILL}', 'hatch_first_class_waiting', '100000000000001', 'm3'),
    ('${OTHER_HATCH}', '${STILL}', 'hatch_something_else',  '100000000000001', 'm4'),
    ('${NOT_HATCH}', '${STILL}', 'welcome_offer',           '100000000000001', 'm5');
`
async function boot(seed = SEED, extraSchema = '') {
  const db = new PGlite()
  await db.exec(SCHEMA + extraSchema)
  if (seed) await db.exec(seed)
  return db
}
const state = async (db) =>
  (await db.query(`SELECT name, location_id FROM public.whatsapp_templates ORDER BY name`)).rows

describe('746 move the three hatch_* templates', () => {
  it('names the three real ids from the spec and the hatch_ name guard', () => {
    for (const id of REAL) expect(MIG_746).toContain(id)
    expect(MIG_746).toContain("LIKE 'hatch\\_%'")
    expect(MIG_746).toContain("name = 'UN1T Hatch Street'")
    expect(MIG_746).toMatch(/APPLY AT GO-LIVE/)
  })

  it('moves exactly the three named rows to Hatch and nothing else', async () => {
    const db = await boot()
    await db.exec(MIG)
    expect(await state(db)).toEqual([
      { name: 'hatch_3_free_classes', location_id: HATCH },
      { name: 'hatch_book_your_week', location_id: HATCH },
      { name: 'hatch_first_class_waiting', location_id: HATCH },
      { name: 'hatch_something_else', location_id: STILL },
      { name: 'welcome_offer', location_id: STILL },
    ])
  })

  it('leaves the WABA and meta ids on the moved rows alone', async () => {
    const db = await boot()
    await db.exec(MIG)
    const r = (await db.query(`SELECT business_account_id, meta_template_id FROM public.whatsapp_templates WHERE id = '${FAKE[0]}'`)).rows[0]
    expect(r).toEqual({ business_account_id: '100000000000001', meta_template_id: 'm1' })
  })

  it('does not move a row with a real id whose name is not hatch_*', async () => {
    const db = await boot(`
      INSERT INTO public.whatsapp_templates (id, location_id, name) VALUES ('${FAKE[0]}', '${STILL}', 'welcome_offer');`)
    await db.exec(MIG)
    expect(await state(db)).toEqual([{ name: 'welcome_offer', location_id: STILL }])
  })

  it('is a no-op when run again', async () => {
    const db = await boot()
    await db.exec(MIG)
    const first = await state(db)
    await db.exec(MIG)
    expect(await state(db)).toEqual(first)
  })

  it('is a no-op when the three rows are not in the database', async () => {
    const db = await boot(`INSERT INTO public.whatsapp_templates (id, location_id, name) VALUES ('${NOT_HATCH}', '${STILL}', 'welcome_offer');`)
    await db.exec(MIG)
    expect(await state(db)).toEqual([{ name: 'welcome_offer', location_id: STILL }])
  })

  it('refuses (and moves nothing) when Hatch cannot be found exactly once', async () => {
    const none = await boot(SEED, `; DELETE FROM public.locations WHERE id = '${HATCH}';`)
    await expect(none.exec(MIG)).rejects.toThrow(/exactly one location/)
    await none.exec('ROLLBACK')
    expect((await state(none)).filter((r) => r.location_id === STILL)).toHaveLength(5)

    const dupe = await boot(SEED, `; INSERT INTO public.locations VALUES ('a0000000-0000-0000-0000-000000000003', 'UN1T Hatch Street');`)
    await expect(dupe.exec(MIG)).rejects.toThrow(/exactly one location/)
    await dupe.exec('ROLLBACK')
    expect((await state(dupe)).filter((r) => r.location_id === STILL)).toHaveLength(5)
  })
})
