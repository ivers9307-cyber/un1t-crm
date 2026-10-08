// EVENT-MOVE.1 — behavioural test for migration 708 (move_race_registration).
//
// Boots PGlite with the race tables reduced to the columns and constraints
// the function touches (UNIQUE (location_id, name) on teams and UNIQUE
// (race_event_id, team_id) on race_registrations kept, as in migs 081/082),
// runs the REAL 708 file, then drives the function: a same-studio move, a
// cross-studio move (team cloned, name clash suffixed), the conflict guards
// under the row lock (each leaves everything untouched), the reminder and
// milestone deletes, and the closed EXECUTE.
//
// Fictional ids only: the repo is public.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const MIG_708 = readFileSync(path.resolve(import.meta.dirname, '../supabase/migrations/708_registration_moves.sql'), 'utf8')

const L1 = 'a0000000-0000-0000-0000-0000000000a1'
const L2 = 'a0000000-0000-0000-0000-0000000000a2'
const C1 = 'c0000000-0000-0000-0000-0000000000c1'
const E1 = 'e0000000-0000-0000-0000-0000000000e1' // source, L1
const E2 = 'e0000000-0000-0000-0000-0000000000e2' // target, L1
const E3 = 'e0000000-0000-0000-0000-0000000000e3' // target, L2
const W1 = 'f0000000-0000-0000-0000-0000000000f1' // on E1
const W2 = 'f0000000-0000-0000-0000-0000000000f2' // on E2
const W3 = 'f0000000-0000-0000-0000-0000000000f3' // on E3
const T1 = '70000000-0000-0000-0000-000000000001' // 'The Crushers' at L1
const T_CLASH = '70000000-0000-0000-0000-000000000002' // 'The Crushers' at L2 already
const R1 = '80000000-0000-0000-0000-000000000001'
const P1 = '90000000-0000-0000-0000-000000000001'

const SCHEMA = `
  CREATE ROLE anon NOLOGIN;
  CREATE ROLE authenticated NOLOGIN;
  CREATE ROLE service_role NOLOGIN BYPASSRLS;
  CREATE TABLE locations (id uuid PRIMARY KEY);
  CREATE TABLE contacts (id uuid PRIMARY KEY);
  CREATE TABLE race_events (
    id uuid PRIMARY KEY, location_id uuid NOT NULL REFERENCES locations(id),
    name text NOT NULL, race_date date NOT NULL, host_id uuid
  );
  CREATE TABLE race_waves (id uuid PRIMARY KEY, race_event_id uuid NOT NULL REFERENCES race_events(id), start_time time);
  CREATE TABLE teams (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), location_id uuid NOT NULL REFERENCES locations(id),
    name text NOT NULL, size int, captain_contact_id uuid REFERENCES contacts(id), notes text,
    UNIQUE (location_id, name)
  );
  CREATE TABLE team_members (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    contact_id uuid REFERENCES contacts(id), name text NOT NULL, email text, role text NOT NULL DEFAULT 'member',
    joined_at timestamptz NOT NULL DEFAULT now(), is_member boolean NOT NULL DEFAULT false,
    member_validation_status text NOT NULL DEFAULT 'not_applicable', member_contact_id uuid REFERENCES contacts(id),
    member_validated_at timestamptz
  );
  CREATE TABLE race_registrations (
    id uuid PRIMARY KEY, race_event_id uuid NOT NULL REFERENCES race_events(id),
    team_id uuid NOT NULL REFERENCES teams(id), contact_id uuid REFERENCES contacts(id),
    status text NOT NULL DEFAULT 'confirmed', wave_id uuid REFERENCES race_waves(id),
    race_started_at timestamptz, race_finished_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (race_event_id, team_id)
  );
  CREATE TABLE race_payments (
    id uuid PRIMARY KEY, race_event_id uuid NOT NULL REFERENCES race_events(id),
    race_registration_id uuid REFERENCES race_registrations(id), amount_cents int NOT NULL
  );
  CREATE TABLE race_checkins (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), race_registration_id uuid NOT NULL REFERENCES race_registrations(id));
  CREATE TABLE event_reminder_sends (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), registration_id uuid NOT NULL REFERENCES race_registrations(id) ON DELETE CASCADE,
    reminder_offset text NOT NULL
  );
  CREATE TABLE contact_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), contact_email text NOT NULL,
    event_type text NOT NULL, source_type text, source_id uuid
  );
`

const SEED = `
  INSERT INTO locations VALUES ('${L1}'), ('${L2}');
  INSERT INTO contacts VALUES ('${C1}');
  INSERT INTO race_events (id, location_id, name, race_date) VALUES
    ('${E1}', '${L1}', 'Oct 18', '2026-10-18'),
    ('${E2}', '${L1}', 'Oct 25', '2026-10-25'),
    ('${E3}', '${L2}', 'Nov 1', '2026-11-01');
  INSERT INTO race_waves VALUES ('${W1}', '${E1}', '10:00'), ('${W2}', '${E2}', '11:00'), ('${W3}', '${E3}', '12:00');
  INSERT INTO teams (id, location_id, name, size, captain_contact_id, notes) VALUES
    ('${T1}', '${L1}', 'The Crushers', 2, '${C1}', 'note'),
    ('${T_CLASH}', '${L2}', 'The Crushers', 4, NULL, NULL);
  INSERT INTO team_members (team_id, contact_id, name, email, role, is_member, member_validation_status) VALUES
    ('${T1}', '${C1}', 'Aoife', 'aoife@example.test', 'captain', true, 'verified'),
    ('${T1}', NULL, 'Dan', 'dan@example.test', 'member', false, 'not_applicable');
  INSERT INTO race_registrations (id, race_event_id, team_id, contact_id, wave_id, updated_at)
    VALUES ('${R1}', '${E1}', '${T1}', '${C1}', '${W1}', '2026-01-01');
  INSERT INTO race_payments VALUES ('${P1}', '${E1}', '${R1}', 5000);
  INSERT INTO event_reminder_sends (registration_id, reminder_offset) VALUES ('${R1}', '3d');
  INSERT INTO contact_events (contact_email, event_type, source_type, source_id) VALUES
    ('aoife@example.test', 'race.starts_in_24h', 'race_registration', '${R1}'),
    ('aoife@example.test', 'race.starts_in_1h', 'race_registration', '${R1}'),
    ('aoife@example.test', 'race.registered', 'race_registration', '${R1}');
`

const MOVE = `SELECT * FROM public.move_race_registration(
  p_registration_id => $1, p_from_event_id => $2, p_to_event_id => $3, p_to_wave_id => $4,
  p_headcount => 2, p_price_gap_cents => 1000, p_forced => false,
  p_actor_type => 'staff', p_actor_id => NULL, p_actor_name => 'Richard', p_note => '  ')`

let db
const run = (sql) => db.exec(sql)
const one = async (sql, params = []) => (await db.query(sql, params)).rows[0]
const all = async (sql, params = []) => (await db.query(sql, params)).rows
const snapshot = async () => ({
  reg: await one('SELECT race_event_id, wave_id, team_id, status, updated_at FROM race_registrations WHERE id = $1', [R1]),
  pay: await one('SELECT race_event_id FROM race_payments WHERE id = $1', [P1]),
  teams: (await one('SELECT count(*)::int AS n FROM teams')).n,
  moves: (await one('SELECT count(*)::int AS n FROM registration_moves')).n,
  reminders: (await one('SELECT count(*)::int AS n FROM event_reminder_sends')).n,
  events: (await one('SELECT count(*)::int AS n FROM contact_events')).n,
})

// Open by default, like a Supabase project before mig 677: every table the
// owner creates in public is readable by the client roles unless the
// migration revokes it. Set BEFORE 708 runs, so the closed-to-clients test
// below proves 708's own REVOKE closes registration_moves (PGlite honours
// ALTER DEFAULT PRIVILEGES; the control table checks it took effect).
const OPEN_DEFAULTS = `
  ALTER DEFAULT PRIVILEGES FOR ROLE current_user IN SCHEMA public GRANT SELECT ON TABLES TO anon, authenticated;
`

beforeEach(async () => {
  db = new PGlite()
  await run(SCHEMA)
  await run(OPEN_DEFAULTS)
  await run(MIG_708)
  await run(SEED)
})
afterEach(async () => { await db.close() })

describe('move_race_registration — a same-studio move', () => {
  it('re-points the entry and its payment, keeps the team, records the move', async () => {
    const move = await one(MOVE, [R1, E1, E2, W2])
    expect(move).toMatchObject({
      registration_id: R1, from_event_id: E1, from_wave_id: W1, to_event_id: E2, to_wave_id: W2,
      from_team_id: T1, to_team_id: T1, headcount: 2, price_gap_cents: 1000, forced: false,
      actor_type: 'staff', actor_name: 'Richard', note: null,
    })
    const reg = await one('SELECT race_event_id, wave_id, team_id, updated_at FROM race_registrations WHERE id = $1', [R1])
    expect(reg).toMatchObject({ race_event_id: E2, wave_id: W2, team_id: T1 })
    expect(reg.updated_at.getTime()).toBeGreaterThan(new Date('2026-01-01T00:00:00Z').getTime())
    expect((await one('SELECT race_event_id FROM race_payments WHERE id = $1', [P1])).race_event_id).toBe(E2)
    expect((await one('SELECT count(*)::int AS n FROM teams')).n).toBe(2)
  })

  it('clears the reminder sends and the pre-race milestones, and keeps the rest of the history', async () => {
    await one(MOVE, [R1, E1, E2, W2])
    expect((await one('SELECT count(*)::int AS n FROM event_reminder_sends')).n).toBe(0)
    expect((await all('SELECT event_type FROM contact_events')).map((r) => r.event_type)).toEqual(['race.registered'])
  })

  it('a move with no target wave takes a null wave', async () => {
    const move = await one(MOVE, [R1, E1, E2, null])
    expect(move.to_wave_id).toBeNull()
    expect((await one('SELECT wave_id FROM race_registrations WHERE id = $1', [R1])).wave_id).toBeNull()
  })
})

describe('move_race_registration — a cross-studio move', () => {
  it('clones the team into the target studio, suffixing a name clash, and leaves the original alone', async () => {
    const move = await one(MOVE, [R1, E1, E3, W3])
    expect(move.from_team_id).toBe(T1)
    expect(move.to_team_id).not.toBe(T1)
    const clone = await one('SELECT location_id, name, size, captain_contact_id, notes FROM teams WHERE id = $1', [move.to_team_id])
    expect(clone).toEqual({ location_id: L2, name: 'The Crushers (2)', size: 2, captain_contact_id: C1, notes: 'note' })
    const cols = 'contact_id, name, email, role, is_member, member_validation_status'
    const orig = await all(`SELECT ${cols} FROM team_members WHERE team_id = $1 ORDER BY name`, [T1])
    expect(orig).toHaveLength(2)
    expect(await all(`SELECT ${cols} FROM team_members WHERE team_id = $1 ORDER BY name`, [move.to_team_id])).toEqual(orig)
    expect(await one('SELECT location_id, name FROM teams WHERE id = $1', [T1])).toEqual({ location_id: L1, name: 'The Crushers' })
    expect(await one('SELECT team_id, race_event_id FROM race_registrations WHERE id = $1', [R1]))
      .toEqual({ team_id: move.to_team_id, race_event_id: E3 })
  })
})

describe('move_race_registration — conflicts under the row lock change nothing', () => {
  const cases = [
    ['the entry is no longer on the judged event', null, [R1, E2, E2, W2]],
    ['the entry was cancelled', `UPDATE race_registrations SET status = 'cancelled' WHERE id = '${R1}'`, [R1, E1, E2, W2]],
    ['the entry has started racing', `UPDATE race_registrations SET race_started_at = now() WHERE id = '${R1}'`, [R1, E1, E2, W2]],
    ['the entry has finished', `UPDATE race_registrations SET race_finished_at = now() WHERE id = '${R1}'`, [R1, E1, E2, W2]],
    ['someone checked in', `INSERT INTO race_checkins (race_registration_id) VALUES ('${R1}')`, [R1, E1, E2, W2]],
    ['the wave belongs to another event', null, [R1, E1, E2, W3]],
  ]
  it.each(cases)('%s: raises conflict (P0003)', async (_name, arrange, params) => {
    if (arrange) await run(arrange)
    const before = await snapshot()
    const err = await db.query(MOVE, params).then(() => null, (e) => e)
    expect(err?.code).toBe('P0003')
    expect(err?.message).toMatch(/conflict/)
    expect(await snapshot()).toEqual(before)
  })

  it('an unknown target event raises target_not_found (P0002) and changes nothing', async () => {
    const before = await snapshot()
    const err = await db.query(MOVE, [R1, E1, 'e0000000-0000-0000-0000-0000000000ff', null]).then(() => null, (e) => e)
    expect(err?.code).toBe('P0002')
    expect(err?.message).toMatch(/target_not_found/)
    expect(await snapshot()).toEqual(before)
  })

  it('an unknown entry raises not_found (P0002)', async () => {
    const err = await db.query(MOVE, ['80000000-0000-0000-0000-0000000000ff', E1, E2, W2]).then(() => null, (e) => e)
    expect(err?.code).toBe('P0002')
  })
})

describe('move_race_registration — closed to clients', () => {
  it('anon and authenticated cannot execute it or read the history table', async () => {
    // Control: the open defaults are live, so a table created now IS readable.
    await run('CREATE TABLE public.control_open (id int)')
    for (const role of ['anon', 'authenticated']) {
      expect((await one(`SELECT has_table_privilege('${role}', 'public.control_open', 'SELECT') AS ok`)).ok).toBe(true)
    }
    const fn = 'public.move_race_registration(uuid, uuid, uuid, uuid, int, int, boolean, text, uuid, text, text)'
    for (const role of ['anon', 'authenticated']) {
      expect((await one(`SELECT has_function_privilege('${role}', '${fn}', 'EXECUTE') AS ok`)).ok).toBe(false)
      expect((await one(`SELECT has_table_privilege('${role}', 'public.registration_moves', 'SELECT') AS ok`)).ok).toBe(false)
    }
  })
})
