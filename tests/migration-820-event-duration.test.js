// CALENDAR.1 — behavioural test for migration 820 (race_events.duration_minutes).
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const MIG_820 = readFileSync(path.resolve(import.meta.dirname, '../supabase/migrations/820_event_duration.sql'), 'utf8')
const SCHEMA = `CREATE TABLE race_events (id uuid PRIMARY KEY, name text NOT NULL);`

let db
beforeEach(async () => {
  db = new PGlite()
  await db.exec(SCHEMA)
  await db.exec(MIG_820)
})

describe('migration 820 — event duration', () => {
  it('adds a nullable integer duration_minutes', async () => {
    const { rows: [c] } = await db.query(`SELECT data_type, is_nullable FROM information_schema.columns WHERE table_name = 'race_events' AND column_name = 'duration_minutes'`)
    expect(c).toEqual({ data_type: 'integer', is_nullable: 'YES' })
  })
  it('refuses a duration under 5 minutes or over a day', async () => {
    await expect(db.query(`INSERT INTO race_events (id, name, duration_minutes) VALUES ('e0000000-0000-0000-0000-0000000000e1', 'W', 0)`)).rejects.toMatchObject({ code: '23514' })
    await expect(db.query(`INSERT INTO race_events (id, name, duration_minutes) VALUES ('e0000000-0000-0000-0000-0000000000e2', 'W', 1441)`)).rejects.toMatchObject({ code: '23514' })
    await db.query(`INSERT INTO race_events (id, name, duration_minutes) VALUES ('e0000000-0000-0000-0000-0000000000e3', 'W', 90)`)
  })
  it('re-applies cleanly', async () => {
    await expect(db.exec(MIG_820)).resolves.not.toThrow()
  })
})
