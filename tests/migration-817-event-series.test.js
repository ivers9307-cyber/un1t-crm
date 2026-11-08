// HOSTSERIES.1 — behavioural test for migration 817 (event_series +
// race_events.series_id). Boots PGlite with the minimal parents, runs the
// REAL file, then checks: the table exists closed to every client role (RLS
// on, no policy, no privilege), the slug is unique, deleting a series leaves
// its dates with series_id NULL, and the file re-applies cleanly.
//
// Fictional ids only: the repo is public.

import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const MIG_817 = readFileSync(path.resolve(import.meta.dirname, '../supabase/migrations/817_event_series.sql'), 'utf8')

const L1 = 'a0000000-0000-0000-0000-0000000000a1'
const H1 = 'b0000000-0000-0000-0000-0000000000b1'
const E1 = 'e0000000-0000-0000-0000-0000000000e1'
const S1 = 'd0000000-0000-0000-0000-0000000000d1'

const SCHEMA = `
  CREATE ROLE anon NOLOGIN;
  CREATE ROLE authenticated NOLOGIN;
  CREATE ROLE service_role NOLOGIN BYPASSRLS;
  CREATE TABLE locations (id uuid PRIMARY KEY);
  CREATE TABLE event_hosts (id uuid PRIMARY KEY);
  CREATE TABLE race_events (
    id uuid PRIMARY KEY, location_id uuid NOT NULL REFERENCES locations(id),
    name text NOT NULL, race_date date, host_id uuid REFERENCES event_hosts(id)
  );
  INSERT INTO locations VALUES ('${L1}');
  INSERT INTO event_hosts VALUES ('${H1}');
  INSERT INTO race_events (id, location_id, name, race_date, host_id) VALUES ('${E1}', '${L1}', 'Workshop', '2026-12-05', '${H1}');
`

let db
beforeEach(async () => {
  db = new PGlite()
  await db.exec(SCHEMA)
  await db.exec(MIG_817)
})

describe('migration 817 — event_series', () => {
  it('creates event_series closed to every client role: RLS on, no policy, no privilege', async () => {
    const { rows: [t] } = await db.query(`
      SELECT c.relrowsecurity AS rls,
             (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'event_series')::int AS policies,
             has_table_privilege('authenticated', 'public.event_series', 'SELECT') AS authed_select,
             has_table_privilege('anon', 'public.event_series', 'SELECT') AS anon_select,
             has_table_privilege('authenticated', 'public.event_series', 'INSERT') AS authed_insert
      FROM pg_class c WHERE c.relname = 'event_series'`)
    expect(t).toMatchObject({ rls: true, policies: 0, authed_select: false, anon_select: false, authed_insert: false })
  })

  it('has the columns the lib writes and reads', async () => {
    const { rows } = await db.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'event_series' ORDER BY column_name`)
    expect(rows.map((r) => r.column_name)).toEqual(['blurb', 'created_at', 'headline', 'host_id', 'id', 'location_id', 'name', 'slug'])
  })

  it('refuses a second series with the same slug', async () => {
    await db.query(`INSERT INTO event_series (id, host_id, location_id, name, slug) VALUES ($1, $2, $3, 'Monthly', 'monthly')`, [S1, H1, L1])
    await expect(db.query(`INSERT INTO event_series (host_id, location_id, name, slug) VALUES ($1, $2, 'Other', 'monthly')`, [H1, L1]))
      .rejects.toMatchObject({ code: '23505' })
  })

  it('adds race_events.series_id, and deleting the series leaves the date with NULL', async () => {
    await db.query(`INSERT INTO event_series (id, host_id, location_id, name, slug) VALUES ($1, $2, $3, 'Monthly', 'monthly')`, [S1, H1, L1])
    await db.query(`UPDATE race_events SET series_id = $1 WHERE id = $2`, [S1, E1])
    const { rows: [before] } = await db.query(`SELECT series_id FROM race_events WHERE id = $1`, [E1])
    expect(before.series_id).toBe(S1)
    await db.query(`DELETE FROM event_series WHERE id = $1`, [S1])
    const { rows: [after] } = await db.query(`SELECT series_id FROM race_events WHERE id = $1`, [E1])
    expect(after.series_id).toBeNull()
  })

  it('deleting the host takes its series with it', async () => {
    await db.query(`INSERT INTO event_series (id, host_id, location_id, name, slug) VALUES ($1, $2, $3, 'Monthly', 'monthly')`, [S1, H1, L1])
    await db.query(`DELETE FROM race_events WHERE id = $1`, [E1])
    await db.query(`DELETE FROM event_hosts WHERE id = $1`, [H1])
    const { rows } = await db.query(`SELECT id FROM event_series`)
    expect(rows).toEqual([])
  })

  it('re-applies cleanly', async () => {
    await expect(db.exec(MIG_817)).resolves.not.toThrow()
  })
})
