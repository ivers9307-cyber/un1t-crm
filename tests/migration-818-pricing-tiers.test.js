// TIERS.1 — behavioural test for migration 818 (race_events.pricing_tiers +
// race_registrations.pricing_tier_id). Boots PGlite with the two parents,
// runs the REAL file, checks the columns, the partial index and a clean
// re-apply. Fictional ids only: the repo is public.

import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const MIG_818 = readFileSync(path.resolve(import.meta.dirname, '../supabase/migrations/818_pricing_tiers.sql'), 'utf8')

const SCHEMA = `
  CREATE TABLE race_events (id uuid PRIMARY KEY, name text NOT NULL);
  CREATE TABLE race_registrations (id uuid PRIMARY KEY, race_event_id uuid NOT NULL REFERENCES race_events(id), status text NOT NULL DEFAULT 'confirmed');
`

let db
beforeEach(async () => {
  db = new PGlite()
  await db.exec(SCHEMA)
  await db.exec(MIG_818)
})

describe('migration 818 — pricing tiers', () => {
  it('adds race_events.pricing_tiers (jsonb, nullable) and race_registrations.pricing_tier_id (text, nullable)', async () => {
    const { rows } = await db.query(`
      SELECT table_name, column_name, data_type, is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND (table_name, column_name) IN (('race_events', 'pricing_tiers'), ('race_registrations', 'pricing_tier_id'))
      ORDER BY table_name`)
    expect(rows).toEqual([
      { table_name: 'race_events', column_name: 'pricing_tiers', data_type: 'jsonb', is_nullable: 'YES' },
      { table_name: 'race_registrations', column_name: 'pricing_tier_id', data_type: 'text', is_nullable: 'YES' },
    ])
  })
  it('indexes registrations by event and tier, only where a tier was bought', async () => {
    const { rows: [idx] } = await db.query(`SELECT indexdef FROM pg_indexes WHERE indexname = 'race_registrations_tier_idx'`)
    expect(idx.indexdef).toMatch(/\(race_event_id, pricing_tier_id\)/)
    expect(idx.indexdef).toMatch(/WHERE \(pricing_tier_id IS NOT NULL\)/)
  })
  it('stores a tier list and a bought tier id', async () => {
    await db.query(`INSERT INTO race_events (id, name, pricing_tiers) VALUES ('e0000000-0000-0000-0000-0000000000e1', 'W', '[{"id":"early","name":"Early bird","price_cents":2500,"capacity":20}]'::jsonb)`)
    await db.query(`INSERT INTO race_registrations (id, race_event_id, pricing_tier_id) VALUES ('80000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-0000000000e1', 'early')`)
    const { rows: [r] } = await db.query(`SELECT e.pricing_tiers->0->>'name' AS tier, r.pricing_tier_id FROM race_registrations r JOIN race_events e ON e.id = r.race_event_id`)
    expect(r).toEqual({ tier: 'Early bird', pricing_tier_id: 'early' })
  })
  it('re-applies cleanly', async () => {
    await expect(db.exec(MIG_818)).resolves.not.toThrow()
  })
})
