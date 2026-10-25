// UN1TBOOK.13 — behavioural test for migration 739 (class_roster location
// feature off where studio_management is off). PGlite with a minimal
// public.locations(id, features jsonb), then the real 739 file.

import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const MIG_739 = readFileSync(
  path.resolve(import.meta.dirname, '../supabase/migrations/739_class_roster_feature_off_where_studio_management_off.sql'),
  'utf8',
)

const id = (n) => `a0000000-0000-0000-0000-${String(n).padStart(12, '0')}`
let db
// PGlite's multi-statement SQL runner (an in-process SQL call, no shell).
const runSql = (text) => db['exec'](text)

async function fresh(rows) {
  db = new PGlite()
  await runSql(`CREATE TABLE public.locations (id uuid PRIMARY KEY, features jsonb);`)
  for (const [n, features] of rows) {
    await db.query(`INSERT INTO public.locations (id, features) VALUES ($1, $2::jsonb)`, [id(n), features == null ? null : JSON.stringify(features)])
  }
}
const featuresOf = async (n) => (await db.query(`SELECT features FROM public.locations WHERE id = $1`, [id(n)])).rows[0].features

afterEach(async () => { await db?.close(); db = null })

describe('mig 739 — class_roster off where studio_management is off', () => {
  it('sets class_roster false where studio_management is false and class_roster is unset, keeping other features', async () => {
    await fresh([
      [1, { studio_management: false, events: true }],
      [2, { studio_management: false }],
      [3, { studio_management: true }],
    ])
    await runSql(MIG_739)
    expect(await featuresOf(1)).toEqual({ studio_management: false, events: true, class_roster: false })
    expect(await featuresOf(2)).toEqual({ studio_management: false, class_roster: false })
  })

  it('leaves a location untouched when class_roster is already true', async () => {
    await fresh([
      [1, { studio_management: false }],
      [2, { studio_management: false }],
      [3, { studio_management: false, class_roster: true }],
    ])
    await runSql(MIG_739)
    expect(await featuresOf(3)).toEqual({ studio_management: false, class_roster: true })
  })

  it('leaves class_roster: false untouched too', async () => {
    await fresh([
      [1, { studio_management: false }],
      [2, { studio_management: false }],
      [3, { studio_management: false, class_roster: false }],
    ])
    await runSql(MIG_739)
    expect(await featuresOf(3)).toEqual({ studio_management: false, class_roster: false })
  })

  it('leaves locations with studio_management unset, true or no features untouched', async () => {
    await fresh([
      [1, { studio_management: false }],
      [2, { studio_management: false }],
      [3, { events: true }],
      [4, { studio_management: true }],
      [5, null],
    ])
    await runSql(MIG_739)
    expect(await featuresOf(3)).toEqual({ events: true })
    expect(await featuresOf(4)).toEqual({ studio_management: true })
    expect(await featuresOf(5)).toBeNull()
  })

  it('is idempotent: a second run passes and changes nothing', async () => {
    await fresh([
      [1, { studio_management: false }],
      [2, { studio_management: false, class_roster: true }],
      [3, { studio_management: true }],
    ])
    await runSql(MIG_739)
    const after = [await featuresOf(1), await featuresOf(2), await featuresOf(3)]
    await expect(runSql(MIG_739)).resolves.toBeDefined()
    expect([await featuresOf(1), await featuresOf(2), await featuresOf(3)]).toEqual(after)
  })

  it('passes on any number of matches, including none', async () => {
    await fresh([[1, { studio_management: false }], [2, { studio_management: false }], [3, { studio_management: false }]])
    await expect(runSql(MIG_739)).resolves.toBeDefined()
    expect(await featuresOf(3)).toEqual({ studio_management: false, class_roster: false })
    await db.close()
    await fresh([[1, { studio_management: true }]])
    await expect(runSql(MIG_739)).resolves.toBeDefined()
  })

  it('raises, and rolls back, when a matching row is still there after the update', async () => {
    await fresh([[1, { studio_management: false }]])
    // A trigger that strips the key the UPDATE just wrote stands in for
    // "the update did not take": the post-state check must catch it.
    await runSql(`
      CREATE FUNCTION public.strip_class_roster() RETURNS trigger LANGUAGE plpgsql AS $f$
      BEGIN NEW.features := NEW.features - 'class_roster'; RETURN NEW; END $f$;
      CREATE TRIGGER strip_class_roster BEFORE UPDATE ON public.locations
        FOR EACH ROW EXECUTE FUNCTION public.strip_class_roster();
    `)
    await expect(runSql(MIG_739)).rejects.toThrow(/still have studio_management off and no class_roster key/)
    await db.query('ROLLBACK').catch(() => {})
    expect(await featuresOf(1)).toEqual({ studio_management: false })
  })
})
