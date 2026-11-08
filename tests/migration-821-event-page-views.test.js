// HOSTSTATS.1 — behavioural test for migration 821 (event_page_views +
// race_registrations.attribution), replayed on PGlite.
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const MIG = readFileSync(path.resolve(import.meta.dirname, '../supabase/migrations/821_event_page_views.sql'), 'utf8')
const SCHEMA = `
  CREATE ROLE anon; CREATE ROLE authenticated;
  CREATE TABLE race_events (id uuid PRIMARY KEY, name text NOT NULL);
  CREATE TABLE race_registrations (id uuid PRIMARY KEY, race_event_id uuid REFERENCES race_events(id));
  INSERT INTO race_events (id, name) VALUES ('e0000000-0000-0000-0000-0000000000e1', 'W');
`

let db
beforeEach(async () => {
  db = new PGlite()
  await db.exec(SCHEMA)
  await db.exec(MIG)
})

describe('migration 821 — event page views', () => {
  it('creates event_page_views keyed unique per (event, session, day), source defaulting to direct', async () => {
    const ins = (sid, day) => db.query(`INSERT INTO event_page_views (race_event_id, session_id, day) VALUES ('e0000000-0000-0000-0000-0000000000e1', $1, $2)`, [sid, day])
    await ins('s1', '2026-07-18')
    await ins('s1', '2026-07-19')
    await expect(ins('s1', '2026-07-18')).rejects.toMatchObject({ code: '23505' })
    const { rows } = await db.query(`SELECT source FROM event_page_views WHERE session_id = 's1' AND day = '2026-07-18'`)
    expect(rows[0].source).toBe('direct')
  })
  it('is closed to every client role, with RLS on', async () => {
    const { rows } = await db.query(`SELECT count(*)::int AS n FROM information_schema.table_privileges WHERE table_name = 'event_page_views' AND grantee IN ('anon', 'authenticated')`)
    expect(rows[0].n).toBe(0)
    const { rows: [t] } = await db.query(`SELECT relrowsecurity FROM pg_class WHERE relname = 'event_page_views'`)
    expect(t.relrowsecurity).toBe(true)
  })
  it('adds race_registrations.attribution as nullable jsonb', async () => {
    const { rows: [c] } = await db.query(`SELECT data_type, is_nullable FROM information_schema.columns WHERE table_name = 'race_registrations' AND column_name = 'attribution'`)
    expect(c).toEqual({ data_type: 'jsonb', is_nullable: 'YES' })
  })
  it('re-applies cleanly', async () => {
    await expect(db.exec(MIG)).resolves.not.toThrow()
  })
})
