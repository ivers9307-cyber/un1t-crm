// QUESTIONS.1 — behavioural test for migration 819 (race_events.
// registration_questions, race_registrations.answers, team_members.answers).
// Boots PGlite with the three parents, runs the REAL file, checks the columns
// and a round trip, and a clean re-apply. Fictional ids only.

import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const MIG_819 = readFileSync(path.resolve(import.meta.dirname, '../supabase/migrations/819_registration_questions.sql'), 'utf8')

const SCHEMA = `
  CREATE TABLE race_events (id uuid PRIMARY KEY, name text NOT NULL);
  CREATE TABLE teams (id uuid PRIMARY KEY);
  CREATE TABLE team_members (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), team_id uuid NOT NULL REFERENCES teams(id), name text NOT NULL);
  CREATE TABLE race_registrations (id uuid PRIMARY KEY, race_event_id uuid NOT NULL REFERENCES race_events(id), team_id uuid REFERENCES teams(id));
`

let db
beforeEach(async () => {
  db = new PGlite()
  await db.exec(SCHEMA)
  await db.exec(MIG_819)
})

describe('migration 819 — registration questions', () => {
  it('adds the three nullable jsonb columns', async () => {
    const { rows } = await db.query(`
      SELECT table_name, column_name, data_type, is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND (table_name, column_name) IN (('race_events', 'registration_questions'), ('race_registrations', 'answers'), ('team_members', 'answers'))
      ORDER BY table_name`)
    expect(rows).toEqual([
      { table_name: 'race_events', column_name: 'registration_questions', data_type: 'jsonb', is_nullable: 'YES' },
      { table_name: 'race_registrations', column_name: 'answers', data_type: 'jsonb', is_nullable: 'YES' },
      { table_name: 'team_members', column_name: 'answers', data_type: 'jsonb', is_nullable: 'YES' },
    ])
  })
  it('round-trips a question list and answers', async () => {
    await db.query(`INSERT INTO race_events (id, name, registration_questions) VALUES ('e0000000-0000-0000-0000-0000000000e1', 'W', '[{"id":"q-diet","label":"Dietary needs","type":"text","required":false,"per":"person"}]'::jsonb)`)
    await db.query(`INSERT INTO teams (id) VALUES ('70000000-0000-0000-0000-000000000001')`)
    await db.query(`INSERT INTO team_members (team_id, name, answers) VALUES ('70000000-0000-0000-0000-000000000001', 'Aoife', '{"q-diet":"vegan"}'::jsonb)`)
    await db.query(`INSERT INTO race_registrations (id, race_event_id, team_id, answers) VALUES ('80000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-0000000000e1', '70000000-0000-0000-0000-000000000001', '{"q-team":"Blue"}'::jsonb)`)
    const { rows: [r] } = await db.query(`
      SELECT e.registration_questions->0->>'label' AS label, r.answers->>'q-team' AS team_answer, m.answers->>'q-diet' AS diet
      FROM race_registrations r JOIN race_events e ON e.id = r.race_event_id JOIN team_members m ON m.team_id = r.team_id`)
    expect(r).toEqual({ label: 'Dietary needs', team_answer: 'Blue', diet: 'vegan' })
  })
  it('re-applies cleanly', async () => {
    await expect(db.exec(MIG_819)).resolves.not.toThrow()
  })
})
