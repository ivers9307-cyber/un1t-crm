// TEAMNAMES.1 — behavioural test for migration 870 (team names per event).
//
// Boots PGlite with the race tables reduced to what 870 touches (teams with
// mig 081's inline UNIQUE (location_id, name), race_registrations with
// UNIQUE (race_event_id, team_id) and its event FK cascade), runs the REAL
// 708 then 870 files over seeded pre-870 rows, then checks: the backfill, the
// new uniqueness (a returning captain's name at a second event; never two of
// a name at one event), the legacy event-less rule, the data guard, a clean
// re-apply, the event-delete cascade, the re-created move function, and the
// closed EXECUTE on the new trigger function.
//
// Fictional ids only: the repo is public.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const MIG_708 = readFileSync(path.resolve(import.meta.dirname, '../supabase/migrations/708_registration_moves.sql'), 'utf8')
const MIG_870 = readFileSync(path.resolve(import.meta.dirname, '../supabase/migrations/870_teams_name_per_event.sql'), 'utf8')

const L1 = 'a0000000-0000-0000-0000-0000000000a1'
const L2 = 'a0000000-0000-0000-0000-0000000000a2'
const C1 = 'c0000000-0000-0000-0000-0000000000c1'
const C2 = 'c0000000-0000-0000-0000-0000000000c2'
const E1 = 'e0000000-0000-0000-0000-0000000000e1' // L1
const E2 = 'e0000000-0000-0000-0000-0000000000e2' // L1
const E3 = 'e0000000-0000-0000-0000-0000000000e3' // L2
const T_ONE = '70000000-0000-0000-0000-000000000001' // 'Rockets', entered at E1 only
const T_MULTI = '70000000-0000-0000-0000-000000000002' // 'Wolves', entered at E1 and E2
const T_NONE = '70000000-0000-0000-0000-000000000003' // 'Ghosts', never entered
const R_ONE = '80000000-0000-0000-0000-000000000001'
const R_MULTI1 = '80000000-0000-0000-0000-000000000002'
const R_MULTI2 = '80000000-0000-0000-0000-000000000003'

const SCHEMA = (teamsUnique = 'UNIQUE (location_id, name)') => `
  CREATE ROLE anon NOLOGIN;
  CREATE ROLE authenticated NOLOGIN;
  CREATE ROLE service_role NOLOGIN BYPASSRLS;
  CREATE TABLE locations (id uuid PRIMARY KEY);
  CREATE TABLE contacts (id uuid PRIMARY KEY);
  CREATE TABLE race_events (
    id uuid PRIMARY KEY, location_id uuid NOT NULL REFERENCES locations(id),
    name text NOT NULL, race_date date NOT NULL, host_id uuid
  );
  CREATE TABLE race_waves (id uuid PRIMARY KEY, race_event_id uuid NOT NULL REFERENCES race_events(id) ON DELETE CASCADE, start_time time);
  CREATE TABLE teams (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), location_id uuid NOT NULL REFERENCES locations(id),
    name text NOT NULL, size int, captain_contact_id uuid REFERENCES contacts(id), notes text,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
    ${teamsUnique ? `, ${teamsUnique}` : ''}
  );
  CREATE TABLE team_members (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    contact_id uuid REFERENCES contacts(id), name text NOT NULL, email text, role text NOT NULL DEFAULT 'member',
    joined_at timestamptz NOT NULL DEFAULT now(), is_member boolean NOT NULL DEFAULT false,
    member_validation_status text NOT NULL DEFAULT 'not_applicable', member_contact_id uuid REFERENCES contacts(id),
    member_validated_at timestamptz
  );
  CREATE TABLE race_registrations (
    id uuid PRIMARY KEY, race_event_id uuid NOT NULL REFERENCES race_events(id) ON DELETE CASCADE,
    team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE, contact_id uuid REFERENCES contacts(id),
    status text NOT NULL DEFAULT 'confirmed', wave_id uuid REFERENCES race_waves(id),
    race_started_at timestamptz, race_finished_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (race_event_id, team_id)
  );
  CREATE TABLE race_payments (
    id uuid PRIMARY KEY, race_event_id uuid NOT NULL REFERENCES race_events(id) ON DELETE CASCADE,
    race_registration_id uuid REFERENCES race_registrations(id) ON DELETE CASCADE, amount_cents int NOT NULL
  );
  CREATE TABLE race_checkins (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), race_registration_id uuid NOT NULL REFERENCES race_registrations(id) ON DELETE CASCADE);
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
  INSERT INTO contacts VALUES ('${C1}'), ('${C2}');
  INSERT INTO race_events (id, location_id, name, race_date) VALUES
    ('${E1}', '${L1}', 'Oct 18', '2026-10-18'),
    ('${E2}', '${L1}', 'Nov 22', '2026-11-22'),
    ('${E3}', '${L2}', 'Nov 29', '2026-11-29');
  INSERT INTO teams (id, location_id, name, size, captain_contact_id) VALUES
    ('${T_ONE}', '${L1}', 'Rockets', 2, '${C1}'),
    ('${T_MULTI}', '${L1}', 'Wolves', 3, '${C2}'),
    ('${T_NONE}', '${L1}', 'Ghosts', 1, NULL);
  INSERT INTO team_members (team_id, contact_id, name, role) VALUES ('${T_ONE}', '${C1}', 'Aoife', 'captain');
  INSERT INTO race_registrations (id, race_event_id, team_id, contact_id) VALUES
    ('${R_ONE}', '${E1}', '${T_ONE}', '${C1}'),
    ('${R_MULTI1}', '${E1}', '${T_MULTI}', '${C2}'),
    ('${R_MULTI2}', '${E2}', '${T_MULTI}', '${C2}');
`

const MOVE = `SELECT * FROM public.move_race_registration(
  p_registration_id => $1, p_from_event_id => $2, p_to_event_id => $3, p_to_wave_id => NULL,
  p_headcount => 2, p_price_gap_cents => 0, p_forced => false,
  p_actor_type => 'staff', p_actor_id => NULL, p_actor_name => 'Staff', p_note => NULL)`

let db
const run = (sql) => db.exec(sql)
const one = async (sql, params = []) => (await db.query(sql, params)).rows[0]
const addTeam = (location, event, name, captain = null) => db.query(
  'INSERT INTO teams (location_id, race_event_id, name, size, captain_contact_id) VALUES ($1, $2, $3, 1, $4) RETURNING id',
  [location, event, name, captain],
)
const errCode = async (p) => { try { await p; return null } catch (e) { return e.code } }

describe('migration 870 — over existing data', () => {
  beforeEach(async () => {
    db = new PGlite()
    await run(SCHEMA())
    await run(MIG_708)
    await run(SEED)
    await run(MIG_870)
  })
  afterEach(async () => { await db.close() })

  it('backfills the event of a team entered at exactly one event, and leaves the rest event-less', async () => {
    expect((await one('SELECT race_event_id FROM teams WHERE id = $1', [T_ONE])).race_event_id).toBe(E1)
    expect((await one('SELECT race_event_id FROM teams WHERE id = $1', [T_MULTI])).race_event_id).toBeNull()
    expect((await one('SELECT race_event_id FROM teams WHERE id = $1', [T_NONE])).race_event_id).toBeNull()
  })

  it('drops the studio-wide unique name', async () => {
    const n = await one(`SELECT count(*)::int AS n FROM pg_constraint WHERE conrelid = 'teams'::regclass AND contype = 'u'`)
    expect(n.n).toBe(0)
  })

  it("a returning captain's team name is free at a second event", async () => {
    const { rows } = await addTeam(L1, E2, 'Rockets', C1)
    expect(rows[0].id).toBeTruthy()
    expect((await one(`SELECT count(*)::int AS n FROM teams WHERE location_id = $1 AND name = 'Rockets'`, [L1])).n).toBe(2)
  })

  it('two teams can never share a name at one event', async () => {
    await addTeam(L1, E2, 'Comets', C1)
    expect(await errCode(addTeam(L1, E2, 'Comets', C2))).toBe('23505')
    expect(await errCode(addTeam(L1, E1, 'Rockets', C2))).toBe('23505') // the backfilled row holds it
  })

  it('a legacy name is free as an event row elsewhere', async () => {
    await addTeam(L1, E2, 'Ghosts', C1)
    expect((await one(`SELECT count(*)::int AS n FROM teams WHERE name = 'Ghosts'`)).n).toBe(2)
  })

  it('an event-less row (code from before 870) keeps a studio-wide unique name, raised as 23505', async () => {
    expect(await errCode(addTeam(L1, null, 'Rockets'))).toBe('23505') // an event row holds it
    expect(await errCode(addTeam(L1, null, 'Wolves'))).toBe('23505') // a legacy row holds it
    const { rows } = await addTeam(L1, null, 'Brand New')
    expect(rows[0].id).toBeTruthy()
    expect((await addTeam(L2, null, 'Rockets')).rows[0].id).toBeTruthy() // another studio
    // A rename into a taken name is refused too.
    expect(await errCode(db.query(`UPDATE teams SET name = 'Wolves' WHERE id = $1`, [T_NONE]))).toBe('23505')
  })

  it('re-applies cleanly', async () => {
    await run(MIG_870)
    expect((await one('SELECT race_event_id FROM teams WHERE id = $1', [T_ONE])).race_event_id).toBe(E1)
  })

  it("deleting an event deletes its team rows (and their rosters), never another event's", async () => {
    const { rows } = await addTeam(L1, E2, 'Comets', C1)
    await run(`DELETE FROM race_events WHERE id = '${E1}'`)
    expect(await one('SELECT id FROM teams WHERE id = $1', [T_ONE])).toBeUndefined()
    expect((await one(`SELECT count(*)::int AS n FROM team_members WHERE team_id = '${T_ONE}'`)).n).toBe(0)
    expect(await one('SELECT id FROM teams WHERE id = $1', [rows[0].id])).toBeDefined()
    expect(await one('SELECT id FROM teams WHERE id = $1', [T_MULTI])).toBeDefined()
  })

  it('the trigger function is closed to client roles', async () => {
    for (const role of ['anon', 'authenticated']) {
      const r = await one(`SELECT has_function_privilege('${role}', 'public.teams_legacy_name_unique()', 'EXECUTE') AS ok`)
      expect(r.ok).toBe(false)
    }
  })
})

describe('migration 870 — move_race_registration carries the event row', () => {
  beforeEach(async () => {
    db = new PGlite()
    await run(SCHEMA())
    await run(MIG_708)
    await run(SEED)
    await run(MIG_870)
  })
  afterEach(async () => { await db.close() })

  it('a same-studio move takes the team row to the target event under its own name', async () => {
    const move = await one(MOVE, [R_ONE, E1, E2])
    expect(move.to_team_id).toBe(T_ONE)
    expect(await one('SELECT race_event_id, name FROM teams WHERE id = $1', [T_ONE])).toEqual({ race_event_id: E2, name: 'Rockets' })
  })

  it('a same-studio move into an event where the name is taken suffixes it', async () => {
    await addTeam(L1, E2, 'Rockets', C2)
    await one(MOVE, [R_ONE, E1, E2])
    expect(await one('SELECT race_event_id, name FROM teams WHERE id = $1', [T_ONE])).toEqual({ race_event_id: E2, name: 'Rockets (2)' })
  })

  it('a legacy row entered at the target holds its name there too', async () => {
    // T_MULTI ('Wolves', legacy) is entered at E2; an E1 'Wolves' event row moving to E2 must not clash.
    await run(`DELETE FROM race_registrations WHERE id = '${R_MULTI1}'`)
    const { rows } = await addTeam(L1, E1, 'Wolves', C1)
    const reg = '80000000-0000-0000-0000-000000000009'
    await run(`INSERT INTO race_registrations (id, race_event_id, team_id) VALUES ('${reg}', '${E1}', '${rows[0].id}')`)
    await one(MOVE, [reg, E1, E2])
    expect((await one('SELECT name FROM teams WHERE id = $1', [rows[0].id])).name).toBe('Wolves (2)')
  })

  it('a same-studio move of a legacy event-less team leaves the row alone', async () => {
    const legacyReg = '80000000-0000-0000-0000-00000000000a'
    const E4 = 'e0000000-0000-0000-0000-0000000000e4'
    await run(`INSERT INTO race_events (id, location_id, name, race_date) VALUES ('${E4}', '${L1}', 'Dec 6', '2026-12-06')`)
    await run(`DELETE FROM race_registrations WHERE id = '${R_MULTI1}'`)
    await run(`INSERT INTO race_registrations (id, race_event_id, team_id) VALUES ('${legacyReg}', '${E1}', '${T_NONE}')`)
    await one(MOVE, [legacyReg, E1, E4])
    expect(await one('SELECT race_event_id, name FROM teams WHERE id = $1', [T_NONE])).toEqual({ race_event_id: null, name: 'Ghosts' })
  })

  it('a cross-studio clone belongs to the target event', async () => {
    await addTeam(L2, E3, 'Rockets', C2)
    const move = await one(MOVE, [R_ONE, E1, E3])
    expect(move.to_team_id).not.toBe(T_ONE)
    expect(await one('SELECT location_id, race_event_id, name FROM teams WHERE id = $1', [move.to_team_id]))
      .toEqual({ location_id: L2, race_event_id: E3, name: 'Rockets (2)' })
    expect(await one('SELECT race_event_id, name FROM teams WHERE id = $1', [T_ONE])).toEqual({ race_event_id: E1, name: 'Rockets' })
  })

  it('keeps the function closed to client roles', async () => {
    const sig = 'public.move_race_registration(uuid, uuid, uuid, uuid, int, int, boolean, text, uuid, text, text)'
    for (const role of ['anon', 'authenticated']) {
      expect((await one(`SELECT has_function_privilege('${role}', '${sig}', 'EXECUTE') AS ok`)).ok).toBe(false)
    }
  })
})

describe('migration 870 — the data guard', () => {
  afterEach(async () => { await db.close() })

  it('aborts, changing nothing, when existing rows would break the new indexes', async () => {
    db = new PGlite()
    await run(SCHEMA(null)) // no unique name: duplicates can exist
    await run(MIG_708)
    await run(SEED)
    await run(`INSERT INTO teams (location_id, name) VALUES ('${L1}', 'Ghosts')`) // a second event-less 'Ghosts'
    await expect(run(MIG_870)).rejects.toThrow(/mig 870: 0 event team name\(s\) and 1 legacy team name\(s\) are duplicated/)
  })

  it('aborts on two rows of one name at one event', async () => {
    db = new PGlite()
    await run(SCHEMA(null))
    await run(MIG_708)
    await run(SEED)
    const dup = '70000000-0000-0000-0000-000000000009'
    const reg = '80000000-0000-0000-0000-000000000009'
    await run(`INSERT INTO teams (id, location_id, name) VALUES ('${dup}', '${L1}', 'Rockets');
      INSERT INTO race_registrations (id, race_event_id, team_id) VALUES ('${reg}', '${E1}', '${dup}')`)
    await expect(run(MIG_870)).rejects.toThrow(/mig 870: 1 event team name\(s\)/)
  })
})
