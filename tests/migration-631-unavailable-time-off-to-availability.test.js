// AVAIL.3 — behavioural test for migration 631: contractors' "unavailable"
// time off moves into staff availability.
//
// Boots PGlite, recreates time_off_requests / staff_allowances /
// profile_compensation / profiles / cron_heartbeats in their prod shape,
// installs the REAL mig 616 allowance trigger function, the REAL mig 630
// availability tables + RPC, and the REAL mig 631 file, then drives
// move_unavailable_time_off_to_availability(today) and
// restore_moved_unavailable_time_off() with a FIXED today. Proves: exactly the
// right rows move, the past and every other type are untouched byte-for-byte,
// a started row is split with no day lost or doubled, nothing is notified,
// allowances cannot move, the guards abort everything, the move is idempotent,
// and the restore brings back the exact rows.
//
// The data move is HELD for the owner's go: applying mig 631 installs the
// ledger and the two functions and moves NOTHING. The move is the separate
// operator script supabase/operator-scripts/631_run_move_unavailable_time_off.sql,
// which the last describe runs against a fresh database to pin both halves.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const read = (name) => readFileSync(path.resolve(import.meta.dirname, '../supabase/migrations', name), 'utf8')
const MIG_616 = read('616_time_off_created_by_allowance_seed.sql')
const MIG_630 = read('630_staff_availability.sql')
const MIG_631 = read('631_unavailable_time_off_to_availability.sql')
const RUN_MOVE = readFileSync(
  path.resolve(import.meta.dirname, '../supabase/operator-scripts/631_run_move_unavailable_time_off.sql'), 'utf8')

const TODAY = '2026-09-25'
const MOVE_SQL = 'SELECT public.move_unavailable_time_off_to_availability($1::date) AS r'
const LOC = 'a0000000-0000-0000-0000-00000000000a'
const CON_A = '10000000-0000-0000-0000-00000000000a' // contractor
const CON_B = '10000000-0000-0000-0000-00000000000b' // contractor
const CON_C = '10000000-0000-0000-0000-00000000000c' // contractor
const FTE = '10000000-0000-0000-0000-00000000000f'   // employee
const GONE = '10000000-0000-0000-0000-0000000000ee'  // tombstoned contractor
const OWNER = '10000000-0000-0000-0000-0000000000aa'

const R = {
  FUTURE: '20000000-0000-0000-0000-000000000001',    // CON_A approved 3-5 Oct, reason ' Wedding '
  STARTED: '20000000-0000-0000-0000-000000000002',   // CON_A approved 20-30 Sep, reason 'Away'
  PAST: '20000000-0000-0000-0000-000000000003',      // CON_A approved 1-2 Sep
  PENDING: '20000000-0000-0000-0000-000000000004',   // CON_B pending 10 Oct, blank reason
  REJECTED: '20000000-0000-0000-0000-000000000005',  // CON_B rejected 12 Oct
  CANCELLED: '20000000-0000-0000-0000-000000000006', // CON_B cancelled 14 Oct
  HOLIDAY: '20000000-0000-0000-0000-000000000007',   // FTE approved holiday 6-8 Oct
  TOMB: '20000000-0000-0000-0000-000000000008',      // GONE approved 20-21 Oct
}

const BASE_SCHEMA = `
  CREATE ROLE anon NOLOGIN;
  CREATE ROLE authenticated NOLOGIN;
  CREATE ROLE service_role NOLOGIN BYPASSRLS;
  GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
  -- Supabase's default privileges: the migration must take the browser's away.
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;

  CREATE TABLE public.locations (id uuid PRIMARY KEY);
  CREATE TABLE public.profiles (id uuid PRIMARY KEY, full_name text, employment_type text, deleted_at timestamptz);
  CREATE TABLE public.profile_compensation (profile_id uuid PRIMARY KEY REFERENCES public.profiles(id), annual_leave_entitlement numeric);
  CREATE TABLE public.cron_heartbeats (
    name text PRIMARY KEY, last_ok_at timestamptz, expected_interval_seconds int, grace_seconds int, notes text
  );
  CREATE TABLE public.staff_allowances (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    profile_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    year int NOT NULL,
    total_days numeric(5,1) NOT NULL DEFAULT 20,
    used_days numeric(5,1) NOT NULL DEFAULT 0,
    carried_over numeric(5,1) NOT NULL DEFAULT 0,
    created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
    UNIQUE (profile_id, year)
  );
  -- mig 011 with mig 283's widened type CHECK.
  CREATE TABLE public.time_off_requests (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    profile_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    location_id uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
    type text NOT NULL CHECK (type = ANY (ARRAY['holiday','sick','unpaid','other','unavailable'])),
    start_date date NOT NULL, end_date date NOT NULL,
    total_days numeric(5,1) NOT NULL DEFAULT 1,
    reason text,
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
    reviewed_by uuid REFERENCES public.profiles(id), reviewed_at timestamptz, review_note text,
    created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
    CONSTRAINT valid_date_range CHECK (end_date >= start_date)
  );
  CREATE FUNCTION public.update_holiday_allowance() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
  CREATE TRIGGER trg_update_holiday_allowance AFTER UPDATE ON public.time_off_requests
    FOR EACH ROW EXECUTE FUNCTION public.update_holiday_allowance();
`

// mig 624's seven columns, in prod's column order (after 616's created_by).
const CANCEL_COLUMNS = `
  ALTER TABLE public.time_off_requests
    ADD COLUMN cancel_requested_at timestamptz,
    ADD COLUMN cancel_requested_by uuid REFERENCES public.profiles(id),
    ADD COLUMN cancel_request_note text,
    ADD COLUMN cancel_decided_at timestamptz,
    ADD COLUMN cancel_decided_by uuid REFERENCES public.profiles(id),
    ADD COLUMN cancel_decision text CHECK (cancel_decision IN ('approved', 'rejected')),
    ADD COLUMN cancel_decision_note text;
`

const SEED = `
  INSERT INTO public.locations VALUES ('${LOC}');
  INSERT INTO public.profiles (id, full_name, employment_type, deleted_at) VALUES
    ('${CON_A}', 'Contractor A', 'contractor', NULL), ('${CON_B}', 'Contractor B', 'contractor', NULL),
    ('${CON_C}', 'Contractor C', 'contractor', NULL), ('${FTE}', 'Employee F', 'fte', NULL),
    ('${GONE}', 'Gone G', 'contractor', '2026-09-01T00:00:00Z'), ('${OWNER}', 'Owner O', 'fte', NULL);
  -- Prod has one contractor allowance row (mig 616 header); it must not move.
  INSERT INTO public.staff_allowances (profile_id, year, total_days, used_days) VALUES
    ('${CON_A}', 2026, 20, 0), ('${FTE}', 2026, 20, 3);
  INSERT INTO public.time_off_requests
    (id, profile_id, location_id, type, start_date, end_date, total_days, reason, status, reviewed_by, reviewed_at, created_at, updated_at) VALUES
    ('${R.FUTURE}',    '${CON_A}', '${LOC}', 'unavailable', '2026-10-03', '2026-10-05', 3,  ' Wedding ', 'approved',  '${OWNER}', '2026-09-10T09:00:00Z', '2026-09-09T09:00:00Z', '2026-09-10T09:00:00Z'),
    ('${R.STARTED}',   '${CON_A}', '${LOC}', 'unavailable', '2026-09-20', '2026-09-30', 11, 'Away',      'approved',  '${OWNER}', '2026-09-11T09:00:00Z', '2026-09-10T09:00:00Z', '2026-09-11T09:00:00Z'),
    ('${R.PAST}',      '${CON_A}', '${LOC}', 'unavailable', '2026-09-01', '2026-09-02', 2,  NULL,        'approved',  '${OWNER}', '2026-08-20T09:00:00Z', '2026-08-19T09:00:00Z', '2026-08-20T09:00:00Z'),
    ('${R.PENDING}',   '${CON_B}', '${LOC}', 'unavailable', '2026-10-10', '2026-10-10', 1,  '',          'pending',   NULL,       NULL,                   '2026-09-24T09:00:00Z', '2026-09-24T09:00:00Z'),
    ('${R.REJECTED}',  '${CON_B}', '${LOC}', 'unavailable', '2026-10-12', '2026-10-12', 1,  NULL,        'rejected',  '${OWNER}', '2026-09-20T09:00:00Z', '2026-09-19T09:00:00Z', '2026-09-20T09:00:00Z'),
    ('${R.CANCELLED}', '${CON_B}', '${LOC}', 'unavailable', '2026-10-14', '2026-10-14', 1,  NULL,        'cancelled', NULL,       NULL,                   '2026-09-19T09:00:00Z', '2026-09-20T09:00:00Z'),
    ('${R.HOLIDAY}',   '${FTE}',   '${LOC}', 'holiday',     '2026-10-06', '2026-10-08', 3,  NULL,        'approved',  '${OWNER}', '2026-09-15T09:00:00Z', '2026-09-14T09:00:00Z', '2026-09-15T09:00:00Z'),
    ('${R.TOMB}',      '${GONE}',  '${LOC}', 'unavailable', '2026-10-20', '2026-10-21', 2,  NULL,        'approved',  '${OWNER}', '2026-08-25T09:00:00Z', '2026-08-24T09:00:00Z', '2026-08-25T09:00:00Z');
`

let db
const runSql = (text) => db.exec(text)
const q = async (sql, params = []) => (await db.query(sql, params)).rows

// Outside a transaction only (grants tests, and the happy-path calls inside
// inTx that are expected to succeed).
async function asRole(role, sql, params = []) {
  await runSql(`SET ROLE ${role}`)
  try { return await db.query(sql, params) } finally { await runSql('RESET ROLE') }
}

const move = async (today = TODAY) => (await asRole('service_role', MOVE_SQL, [today])).rows[0].r
const restoreBatch = async (batchId) =>
  (await asRole('service_role', 'SELECT public.restore_moved_unavailable_time_off($1::uuid) AS r', [batchId])).rows[0].r
const restore = async () =>
  (await asRole('service_role', 'SELECT public.restore_moved_unavailable_time_off() AS r')).rows[0].r

/** Each test starts from SEED and leaves nothing behind. */
async function inTx(fn) {
  await runSql('BEGIN')
  try {
    await runSql(SEED)
    await fn()
  } finally {
    await runSql('ROLLBACK')
  }
}

/**
 * Inside inTx: run `sql` as service_role, expect it to raise `re`, then undo
 * just that statement (ROLLBACK TO SAVEPOINT also undoes the SET ROLE) so the
 * test can keep reading.
 */
async function expectRaise(sql, params, re) {
  await runSql('SAVEPOINT before_raise')
  await runSql('SET ROLE service_role')
  let error = null
  try { await db.query(sql, params) } catch (e) { error = e }
  await runSql('ROLLBACK TO SAVEPOINT before_raise')
  await runSql('RESET ROLE')
  expect(error?.message).toMatch(re)
}

const rowJson = async (id) => (await q('SELECT to_jsonb(r) AS j FROM public.time_off_requests r WHERE id = $1', [id]))[0]?.j ?? null
const allTimeOff = async () => q('SELECT to_jsonb(r) AS j FROM public.time_off_requests r ORDER BY id')
const allowances = async () => q('SELECT to_jsonb(s) AS j FROM public.staff_allowances s ORDER BY id')
const rulesOf = async (profileId) => q(
  `SELECT kind, start_date::text, end_date::text, all_day, start_time, end_time, note
     FROM public.staff_unavailability WHERE profile_id = $1 ORDER BY start_date, end_date`, [profileId])

beforeAll(async () => {
  db = new PGlite()
  await runSql(BASE_SCHEMA)
  await runSql(MIG_616)
  await runSql(CANCEL_COLUMNS)
  await runSql(MIG_630)
  await runSql(MIG_631) // installs only: the move is a separate, held operator script
}, 60_000)

afterAll(async () => { await db?.close() })

describe('migration 631 — grants and posture', () => {
  it('the browser roles hold nothing on the ledger and cannot run either function', async () => {
    for (const role of ['anon', 'authenticated']) {
      await expect(asRole(role, 'SELECT 1 FROM public.time_off_availability_moves')).rejects.toThrow(/permission denied/)
      await expect(asRole(role, `SELECT public.move_unavailable_time_off_to_availability('${TODAY}')`)).rejects.toThrow(/permission denied/)
      await expect(asRole(role, 'SELECT public.restore_moved_unavailable_time_off()')).rejects.toThrow(/permission denied/)
    }
  })

  // Review N4 — the app role only ever reads, records and stamps the ledger;
  // it can never erase the rollback record. (The re-move step's DELETE is an
  // operator action as the table owner, not service_role.)
  it('service_role can SELECT, INSERT and UPDATE the ledger, never DELETE or TRUNCATE it', async () => {
    const privs = await q(`SELECT p, has_table_privilege('service_role', 'public.time_off_availability_moves', p) AS ok
                             FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p`)
    expect(Object.fromEntries(privs.map((r) => [r.p, r.ok]))).toEqual({
      SELECT: true, INSERT: true, UPDATE: true, DELETE: false, TRUNCATE: false, REFERENCES: false, TRIGGER: false,
    })
  })

  it('RLS is on and there are no policies on the ledger', async () => {
    expect(await q(`SELECT relrowsecurity FROM pg_class WHERE oid = 'public.time_off_availability_moves'::regclass`))
      .toEqual([{ relrowsecurity: true }])
    expect(await q(`SELECT count(*)::int AS n FROM pg_policies WHERE tablename = 'time_off_availability_moves'`))
      .toEqual([{ n: 0 }])
  })
})

describe('migration 631 — the move', () => {
  it('moves future + pending, splits started, leaves the rest byte-for-byte', () => inTx(async () => {
    const untouched = {}
    for (const k of ['PAST', 'REJECTED', 'CANCELLED', 'HOLIDAY', 'TOMB']) untouched[k] = await rowJson(R[k])

    const r = await move()
    expect(r).toMatchObject({ moved: 2, split: 1, rules_inserted: 3, rules_reused: 0, people: 2 })

    expect(await rowJson(R.FUTURE)).toBeNull()
    expect(await rowJson(R.PENDING)).toBeNull()
    expect(await rowJson(R.STARTED)).toMatchObject({
      start_date: '2026-09-20', end_date: '2026-09-24', total_days: 5, status: 'approved', type: 'unavailable',
    })
    for (const k of Object.keys(untouched)) expect(await rowJson(R[k])).toEqual(untouched[k])
  }))

  it('rules are dated, all day, today..end, note trimmed (blank is null)', () => inTx(async () => {
    await move()
    expect(await rulesOf(CON_A)).toEqual([
      { kind: 'dated', start_date: '2026-09-25', end_date: '2026-09-30', all_day: true, start_time: null, end_time: null, note: 'Away' },
      { kind: 'dated', start_date: '2026-10-03', end_date: '2026-10-05', all_day: true, start_time: null, end_time: null, note: 'Wedding' },
    ])
    expect(await rulesOf(CON_B)).toEqual([
      { kind: 'dated', start_date: '2026-10-10', end_date: '2026-10-10', all_day: true, start_time: null, end_time: null, note: null },
    ])
    expect(await rulesOf(GONE)).toEqual([])
  }))

  it('the ledger holds the FULL original row of everything it touched', () => inTx(async () => {
    const before = { FUTURE: await rowJson(R.FUTURE), STARTED: await rowJson(R.STARTED), PENDING: await rowJson(R.PENDING) }
    await move()
    const ledger = await q(`SELECT time_off_request_id AS id, action, original, rule_inserted, moved_today::text
                              FROM public.time_off_availability_moves ORDER BY time_off_request_id`)
    expect(ledger).toEqual([
      { id: R.FUTURE, action: 'moved', original: before.FUTURE, rule_inserted: true, moved_today: TODAY },
      { id: R.STARTED, action: 'split', original: before.STARTED, rule_inserted: true, moved_today: TODAY },
      { id: R.PENDING, action: 'moved', original: before.PENDING, rule_inserted: true, moved_today: TODAY },
    ])
  }))

  it('no notice, no change row, no allowance change (the REAL mig 616 trigger ran on the split)', () => inTx(async () => {
    const allowancesBefore = await allowances()
    await move()
    expect(await q('SELECT count(*)::int AS n FROM public.staff_availability_changes')).toEqual([{ n: 0 }])
    expect(await allowances()).toEqual(allowancesBefore)
  }))

  it('a save of the same set through the AVAIL.1 RPC is a no-op (the carried rules are canonical)', () => inTx(async () => {
    await move()
    const dated = [
      { start_date: '2026-09-25', end_date: '2026-09-30', all_day: true, note: 'Away' },
      { start_date: '2026-10-03', end_date: '2026-10-05', all_day: true, note: 'Wedding' },
    ]
    const { rows } = await asRole('service_role',
      'SELECT public.replace_staff_unavailability($1, $1, $2::date, $3::jsonb, $4::jsonb) AS r',
      [CON_A, TODAY, '[]', JSON.stringify(dated)])
    expect(rows[0].r).toMatchObject({ changed: false, change_id: null })
  }))

  // Review N1 — the note is trimmed exactly as JS .trim() trims it (the
  // editor and the route normalise with .trim()), so the coach's first save
  // of an untouched editor is still a no-op.
  it('the note is trimmed like JS .trim() (tabs, newlines, no-break spaces), so a first save is a no-op', () => inTx(async () => {
    const reason = '\t\u00a0Hospital visit\n\u2003\ufeff'
    await runSql(`UPDATE public.time_off_requests SET reason = E'${reason.replace(/\n/g, '\\n').replace(/\t/g, '\\t')}' WHERE id = '${R.FUTURE}'`)
    expect((await rowJson(R.FUTURE)).reason).toBe(reason)
    await move()
    const notes = (await rulesOf(CON_A)).map((x) => x.note)
    expect(notes).toEqual(['Away', reason.trim()])
    const dated = [
      { start_date: '2026-09-25', end_date: '2026-09-30', all_day: true, note: 'Away' },
      { start_date: '2026-10-03', end_date: '2026-10-05', all_day: true, note: reason.trim() },
    ]
    const { rows } = await asRole('service_role',
      'SELECT public.replace_staff_unavailability($1, $1, $2::date, $3::jsonb, $4::jsonb) AS r',
      [CON_A, TODAY, '[]', JSON.stringify(dated)])
    expect(rows[0].r).toMatchObject({ changed: false, change_id: null })
  }))

  it('a reason that is only whitespace (any kind) carries as no note', () => inTx(async () => {
    await runSql(`UPDATE public.time_off_requests SET reason = E'\\n\\t ' || chr(160) WHERE id = '${R.FUTURE}'`)
    await move()
    expect((await rulesOf(CON_A)).map((x) => x.note)).toEqual(['Away', null])
  }))

  it('every carried day is covered, every elapsed day kept, and no day is in both', () => inTx(async () => {
    await move()
    const lost = await q(`
      SELECT m.profile_id, g.d::date::text AS day
        FROM public.time_off_availability_moves m,
             generate_series(greatest((m.original->>'start_date')::date, m.moved_today),
                             (m.original->>'end_date')::date, interval '1 day') g(d)
       WHERE NOT EXISTS (SELECT 1 FROM public.staff_unavailability u
                          WHERE u.profile_id = m.profile_id AND u.kind = 'dated' AND u.all_day
                            AND g.d::date BETWEEN u.start_date AND u.end_date)`)
    expect(lost).toEqual([])
    const doubled = await q(`
      SELECT r.id FROM public.time_off_requests r
        JOIN public.staff_unavailability u ON u.profile_id = r.profile_id AND u.kind = 'dated'
                                          AND u.start_date <= r.end_date AND r.start_date <= u.end_date
       WHERE r.type = 'unavailable' AND r.status IN ('approved', 'pending')`)
    expect(doubled).toEqual([])
    expect(await q(`SELECT start_date::text, end_date::text FROM public.time_off_requests WHERE id = $1`, [R.STARTED]))
      .toEqual([{ start_date: '2026-09-20', end_date: '2026-09-24' }])
  }))

  it('is idempotent: a second run finds nothing and changes nothing', () => inTx(async () => {
    await move()
    const timeOff = await allTimeOff()
    const rules = await q('SELECT to_jsonb(u) AS j FROM public.staff_unavailability u ORDER BY id')
    expect(await move()).toMatchObject({ moved: 0, split: 0, rules_inserted: 0, people: 0 })
    expect(await allTimeOff()).toEqual(timeOff)
    expect(await q('SELECT to_jsonb(u) AS j FROM public.staff_unavailability u ORDER BY id')).toEqual(rules)
    expect(await q('SELECT count(*)::int AS n FROM public.time_off_availability_moves')).toEqual([{ n: 3 }])
  }))

  it('duplicates collapse; an identical rule the coach already declared is reused', () => inTx(async () => {
    await runSql(`
      INSERT INTO public.time_off_requests (profile_id, location_id, type, start_date, end_date, total_days, reason, status, created_at)
      VALUES ('${CON_C}', '${LOC}', 'unavailable', '2026-10-15', '2026-10-16', 2, 'first',  'approved', '2026-09-01T00:00:00Z'),
             ('${CON_C}', '${LOC}', 'unavailable', '2026-10-15', '2026-10-16', 2, 'second', 'approved', '2026-09-02T00:00:00Z');
      INSERT INTO public.staff_unavailability (profile_id, kind, start_date, end_date, all_day, note)
      VALUES ('${CON_B}', 'dated', '2026-10-10', '2026-10-10', true, 'said it myself');`)
    expect(await move()).toMatchObject({ moved: 4, split: 1, rules_inserted: 3, rules_reused: 2, people: 3 })
    // One rule for the pair, carrying the EARLIER request's note; the other note stays in the ledger.
    expect(await rulesOf(CON_C)).toEqual([
      { kind: 'dated', start_date: '2026-10-15', end_date: '2026-10-16', all_day: true, start_time: null, end_time: null, note: 'first' },
    ])
    // The coach's own rule is kept as they wrote it, and not duplicated.
    expect(await rulesOf(CON_B)).toEqual([
      { kind: 'dated', start_date: '2026-10-10', end_date: '2026-10-10', all_day: true, start_time: null, end_time: null, note: 'said it myself' },
    ])
    expect(await q(`SELECT rule_inserted FROM public.time_off_availability_moves WHERE time_off_request_id = $1`, [R.PENDING]))
      .toEqual([{ rule_inserted: false }])
  }))

  // Review N5 — "the earliest request's note" is judged on the instant, not
  // on to_jsonb's text. Across the Dublin clock change the text sorts wrong:
  // 00:20Z renders "…T01:20:00+01:00", 01:10Z renders "…T01:10:00+00:00".
  it('the earliest note wins by instant, even across a clock change', () => inTx(async () => {
    await runSql(`SET LOCAL TimeZone = 'Europe/Dublin'`)
    await runSql(`
      INSERT INTO public.time_off_requests (profile_id, location_id, type, start_date, end_date, total_days, reason, status, created_at)
      VALUES ('${CON_C}', '${LOC}', 'unavailable', '2026-11-10', '2026-11-11', 2, 'later',   'approved', '2026-10-25T01:10:00Z'),
             ('${CON_C}', '${LOC}', 'unavailable', '2026-11-10', '2026-11-11', 2, 'earlier', 'approved', '2026-10-25T00:20:00Z');`)
    const texts = (await q(`SELECT to_jsonb(r)->>'created_at' AS t FROM public.time_off_requests r WHERE profile_id = '${CON_C}' ORDER BY created_at`)).map((r) => r.t)
    expect(texts).toEqual(['2026-10-25T01:20:00+01:00', '2026-10-25T01:10:00+00:00']) // text order would invert them
    await move()
    expect((await rulesOf(CON_C)).map((x) => x.note)).toEqual(['earlier'])
  }))

  it('an overlapping pair (different ranges) keeps both rules', () => inTx(async () => {
    await runSql(`
      INSERT INTO public.time_off_requests (profile_id, location_id, type, start_date, end_date, total_days, status)
      VALUES ('${CON_C}', '${LOC}', 'unavailable', '2026-11-01', '2026-11-05', 5, 'approved'),
             ('${CON_C}', '${LOC}', 'unavailable', '2026-11-04', '2026-11-08', 5, 'approved');`)
    await move()
    expect((await rulesOf(CON_C)).map((x) => [x.start_date, x.end_date]))
      .toEqual([['2026-11-01', '2026-11-05'], ['2026-11-04', '2026-11-08']])
  }))
})

describe('migration 631 — guards abort the whole move', () => {
  const nothingMoved = async () => {
    expect(await q('SELECT count(*)::int AS n FROM public.time_off_availability_moves')).toEqual([{ n: 0 }])
    expect(await q('SELECT count(*)::int AS n FROM public.staff_unavailability')).toEqual([{ n: 0 }])
    expect(await rowJson(R.FUTURE)).not.toBeNull()
    expect((await rowJson(R.STARTED)).end_date).toBe('2026-09-30')
  }

  it('an open cancellation ask', () => inTx(async () => {
    await runSql(`UPDATE public.time_off_requests SET cancel_requested_at = now(), cancel_requested_by = '${CON_A}' WHERE id = '${R.FUTURE}'`)
    await expectRaise(MOVE_SQL, [TODAY], /avail3_open_cancel_ask/)
    await nothingMoved()
  }))

  it('a decided ask is not open: the row moves', () => inTx(async () => {
    await runSql(`UPDATE public.time_off_requests
                     SET cancel_requested_at = now(), cancel_requested_by = '${CON_A}',
                         cancel_decided_at = now(), cancel_decided_by = '${OWNER}', cancel_decision = 'rejected'
                   WHERE id = '${R.FUTURE}'`)
    expect(await move()).toMatchObject({ moved: 2 })
  }))

  it('a note over 200 characters (never truncated)', () => inTx(async () => {
    await runSql(`UPDATE public.time_off_requests SET reason = repeat('x', 201) WHERE id = '${R.FUTURE}'`)
    await expectRaise(MOVE_SQL, [TODAY], /avail3_note_too_long/)
    await nothingMoved()
  }))

  // Review N2 — the editor counts UTF-16 units (shared/availability.js:
  // note.length > 200). 100 emoji + 1 letter is 101 Postgres characters but
  // 201 units: carried, the coach's next save would be refused.
  it('a note over 200 UTF-16 units, even under 200 Postgres characters', () => inTx(async () => {
    const note = '😀'.repeat(100) + 'x'
    expect(note.length).toBe(201)
    await runSql(`UPDATE public.time_off_requests SET reason = '${note}' WHERE id = '${R.FUTURE}'`)
    expect((await q('SELECT char_length(reason)::int AS n FROM public.time_off_requests WHERE id = $1', [R.FUTURE]))).toEqual([{ n: 101 }])
    await expectRaise(MOVE_SQL, [TODAY], /avail3_note_too_long/)
    await nothingMoved()
  }))

  it('exactly 200 UTF-16 units carries', () => inTx(async () => {
    const note = '😀'.repeat(100)
    await runSql(`UPDATE public.time_off_requests SET reason = '${note}' WHERE id = '${R.FUTURE}'`)
    await move()
    expect((await rulesOf(CON_A)).map((x) => x.note)).toEqual(['Away', note])
  }))

  it('a date more than two years ahead', () => inTx(async () => {
    await runSql(`INSERT INTO public.time_off_requests (profile_id, location_id, type, start_date, end_date, total_days, status)
                  VALUES ('${CON_C}', '${LOC}', 'unavailable', '2028-09-26', '2028-09-26', 1, 'approved')`)
    await expectRaise(MOVE_SQL, [TODAY], /avail3_too_far_ahead/)
    await nothingMoved()
  }))

  it('more than 60 current dated rules for one person', () => inTx(async () => {
    // 59 existing one-day rules + CON_A's 2 carried = 61.
    await runSql(`INSERT INTO public.staff_unavailability (profile_id, kind, start_date, end_date, all_day)
                  SELECT '${CON_A}', 'dated', d, d, true
                    FROM generate_series('2026-11-01'::date, '2026-12-29'::date, interval '1 day') g(d)`)
    await expectRaise(MOVE_SQL, [TODAY], /avail3_too_many_dates/)
    expect(await q('SELECT count(*)::int AS n FROM public.time_off_availability_moves')).toEqual([{ n: 0 }])
    expect(await rowJson(R.FUTURE)).not.toBeNull()
  }))

  // Review D3 — a DELETE is only safe while nothing references the table: an
  // FK would either cascade (silently deleting its rows) or refuse mid-move.
  it('a foreign key into time_off_requests', () => inTx(async () => {
    await runSql(`CREATE TABLE public.leave_notes (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                    time_off_request_id uuid REFERENCES public.time_off_requests(id) ON DELETE CASCADE)`)
    await expectRaise(MOVE_SQL, [TODAY], /avail3_fk_into_time_off: .*leave_notes/)
    await nothingMoved()
  }))

  it('no today', () => inTx(async () => {
    await expectRaise('SELECT public.move_unavailable_time_off_to_availability(NULL)', [], /avail3_bad_args/)
  }))
})

describe('migration 631 — restore', () => {
  it('restores every row byte-for-byte and removes the carried rules', () => inTx(async () => {
    const timeOff = await allTimeOff()
    const allowancesBefore = await allowances()
    await move()
    expect(await restore()).toMatchObject({ restored: 3, rules_removed: 3, rules_changed_since: 0 })
    expect(await allTimeOff()).toEqual(timeOff)
    expect(await allowances()).toEqual(allowancesBefore)
    expect(await q('SELECT count(*)::int AS n FROM public.staff_unavailability')).toEqual([{ n: 0 }])
    expect(await q('SELECT DISTINCT restore_outcome FROM public.time_off_availability_moves'))
      .toEqual([{ restore_outcome: 'restored' }])
  }))

  it('leaves a rule the coach has changed since, and reports it', () => inTx(async () => {
    await move()
    await runSql(`UPDATE public.staff_unavailability SET note = 'my own words'
                   WHERE profile_id = '${CON_A}' AND start_date = '2026-10-03'`)
    expect(await restore()).toMatchObject({ restored: 3, rules_removed: 2, rules_changed_since: 1 })
    expect(await rowJson(R.FUTURE)).not.toBeNull()
    expect((await rulesOf(CON_A)).map((x) => x.note)).toEqual(['my own words'])
    expect(await q('SELECT restore_outcome FROM public.time_off_availability_moves WHERE time_off_request_id = $1', [R.FUTURE]))
      .toEqual([{ restore_outcome: 'restored_rule_changed' }])
  }))

  // Review D4 — the ledger's copy predates any later column. A column added
  // since takes its default; the saved columns come back exactly.
  it('still restores after time_off_requests gains a NOT NULL DEFAULT column', () => inTx(async () => {
    const before = await allTimeOff()
    await move()
    await runSql(`ALTER TABLE public.time_off_requests ADD COLUMN source text NOT NULL DEFAULT 'app'`)
    expect(await restore()).toMatchObject({ restored: 3, rules_removed: 3 })
    expect(await allTimeOff()).toEqual(before.map(({ j }) => ({ j: { ...j, source: 'app' } })))
  }))

  it('refuses, clearly and before touching anything, when a saved column no longer exists', () => inTx(async () => {
    await move()
    const after = await allTimeOff()
    await runSql('ALTER TABLE public.time_off_requests DROP COLUMN review_note')
    await expectRaise('SELECT public.restore_moved_unavailable_time_off()', [], /avail3_restore_shape: .*review_note/)
    expect((await allTimeOff()).length).toBe(after.length)
    expect(await q('SELECT count(*)::int AS n FROM public.time_off_availability_moves WHERE restored_at IS NOT NULL')).toEqual([{ n: 0 }])
  }))

  it('is idempotent', () => inTx(async () => {
    await move()
    await restore()
    const timeOff = await allTimeOff()
    expect(await restore()).toMatchObject({ restored: 0, rules_removed: 0, rules_changed_since: 0 })
    expect(await allTimeOff()).toEqual(timeOff)
  }))

  // Review D2 — a rule one batch inserted and a LATER batch reused must not be
  // deleted by restoring the first batch alone: the later batch's request is
  // gone from time off, so the rule is the only record of its days.
  it('restoring one batch keeps a rule a later batch still relies on; the last restore removes it', () => inTx(async () => {
    const first = await move()
    const straggler = '20000000-0000-0000-0000-0000000000d2'
    // Filed after the first move (an old phone), same dates as R.FUTURE.
    await runSql(`INSERT INTO public.time_off_requests (id, profile_id, location_id, type, start_date, end_date, total_days, reason, status, created_at)
                  VALUES ('${straggler}', '${CON_A}', '${LOC}', 'unavailable', '2026-10-03', '2026-10-05', 3, 'Wedding', 'approved', '2026-09-25T12:00:00Z')`)
    const stragglerRow = await rowJson(straggler)
    const second = await move()
    expect(second).toMatchObject({ moved: 1, split: 0, rules_inserted: 0, rules_reused: 1 })

    expect(await restoreBatch(first.batch_id)).toMatchObject({ restored: 3, rules_removed: 2, rules_changed_since: 0, rules_kept_in_use: 1 })
    // The straggler is still moved, so its days must still be covered.
    expect(await rowJson(straggler)).toBeNull()
    expect((await rulesOf(CON_A)).map((x) => [x.start_date, x.end_date])).toEqual([['2026-10-03', '2026-10-05']])
    expect(await q('SELECT restore_outcome FROM public.time_off_availability_moves WHERE time_off_request_id = $1', [R.FUTURE]))
      .toEqual([{ restore_outcome: 'restored_rule_in_use' }])

    // Restoring the later batch too: the rule goes, every row is back.
    expect(await restoreBatch(second.batch_id)).toMatchObject({ restored: 1, rules_removed: 1, rules_changed_since: 0, rules_kept_in_use: 0 })
    expect(await rulesOf(CON_A)).toEqual([])
    expect(await rowJson(straggler)).toEqual(stragglerRow)
    expect(await rowJson(R.FUTURE)).not.toBeNull()
  }))

  it('restoring everything at once removes a rule shared across batches exactly once', () => inTx(async () => {
    const before = await allTimeOff()
    await move()
    await runSql(`INSERT INTO public.time_off_requests (profile_id, location_id, type, start_date, end_date, total_days, reason, status)
                  VALUES ('${CON_A}', '${LOC}', 'unavailable', '2026-10-03', '2026-10-05', 3, 'Wedding', 'approved')`)
    await move()
    expect(await restore()).toMatchObject({ restored: 4, rules_removed: 3, rules_changed_since: 0, rules_kept_in_use: 0 })
    expect(await q('SELECT count(*)::int AS n FROM public.staff_unavailability')).toEqual([{ n: 0 }])
    expect((await allTimeOff()).length).toBe(before.length + 1)
  }))

  it('a restored row is not moved again by a later run (the ledger remembers it)', () => inTx(async () => {
    await move()
    await restore()
    expect(await move()).toMatchObject({ moved: 0, split: 0 })
  }))
})


describe('migration 631 — applying the file moves NOTHING; the held operator script does the move', () => {
  it('the file only installs; the script carries a future row and splits a started one, relative to the Dublin day', async () => {
    const fresh = new PGlite()
    try {
      await fresh.exec(BASE_SCHEMA)
      await fresh.exec(MIG_616)
      await fresh.exec(CANCEL_COLUMNS)
      await fresh.exec(MIG_630)
      await fresh.exec(`
        INSERT INTO public.locations VALUES ('${LOC}');
        INSERT INTO public.profiles (id, full_name, employment_type) VALUES ('${CON_A}', 'Contractor A', 'contractor');
        INSERT INTO public.time_off_requests (id, profile_id, location_id, type, start_date, end_date, total_days, status) VALUES
          ('${R.FUTURE}',  '${CON_A}', '${LOC}', 'unavailable',
             (now() AT TIME ZONE 'Europe/Dublin')::date + 10, (now() AT TIME ZONE 'Europe/Dublin')::date + 12, 3, 'approved'),
          ('${R.STARTED}', '${CON_A}', '${LOC}', 'unavailable',
             (now() AT TIME ZONE 'Europe/Dublin')::date - 3,  (now() AT TIME ZONE 'Europe/Dublin')::date + 3,  7, 'approved');`)
      const before = (await fresh.query('SELECT to_jsonb(r) AS j FROM public.time_off_requests r ORDER BY id')).rows

      // 1. Applying the migration moves nothing: both rows byte-identical, no
      //    ledger row, no rule. (The owner's go is a separate step.)
      await fresh.exec(MIG_631)
      expect((await fresh.query('SELECT to_jsonb(r) AS j FROM public.time_off_requests r ORDER BY id')).rows).toEqual(before)
      expect((await fresh.query('SELECT count(*)::int AS n FROM public.time_off_availability_moves')).rows).toEqual([{ n: 0 }])
      expect((await fresh.query('SELECT count(*)::int AS n FROM public.staff_unavailability')).rows).toEqual([{ n: 0 }])

      // 2. The operator script is the move, for the Dublin day it runs on.
      const out = await fresh.exec(RUN_MOVE)
      const result = out.at(-1).rows[0].result
      expect(result).toMatchObject({ moved: 1, split: 1, rules_inserted: 2, rules_reused: 0, people: 1 })
      expect((await fresh.query('SELECT action FROM public.time_off_availability_moves ORDER BY action')).rows)
        .toEqual([{ action: 'moved' }, { action: 'split' }])
      const left = (await fresh.query(`
        SELECT id, end_date = (now() AT TIME ZONE 'Europe/Dublin')::date - 1 AS ends_yesterday, total_days::float8 AS total_days
          FROM public.time_off_requests`)).rows
      expect(left).toEqual([{ id: R.STARTED, ends_yesterday: true, total_days: 3 }])

      // 3. Re-running the script is a no-op (a straggler sweep, never a double move).
      const again = (await fresh.exec(RUN_MOVE)).at(-1).rows[0].result
      expect(again).toMatchObject({ moved: 0, split: 0, rules_inserted: 0, people: 0 })
    } finally {
      await fresh.close()
    }
  }, 60_000)

  it('the migration file never calls the move function (the call lives only in the operator script)', () => {
    const code = MIG_631.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n')
    expect(code).not.toMatch(/PERFORM\s+public\.move_unavailable_time_off_to_availability|SELECT\s+public\.move_unavailable_time_off_to_availability|:=\s*public\.move_unavailable_time_off_to_availability/)
    expect(RUN_MOVE).toMatch(/SELECT public\.move_unavailable_time_off_to_availability\(\(now\(\) AT TIME ZONE 'Europe\/Dublin'\)::date\) AS result;/)
  })
})
