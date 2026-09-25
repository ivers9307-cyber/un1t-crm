// AVAIL.1 — behavioural test for migration 630 (staff availability).
//
// Boots PGlite, recreates the minimum prod shape the file touches (profiles,
// cron_heartbeats, the three API roles with Supabase's default privileges),
// applies the REAL file and checks: the browser roles hold nothing on either
// table or the RPC; the CHECKs refuse malformed rules; and the RPC's rules:
// replace weekly + current/future dated, keep past dated as history, refuse a
// past date, no-op (no change row) when nothing changed.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const MIGRATION = readFileSync(
  path.resolve(import.meta.dirname, '../supabase/migrations/630_staff_availability.sql'),
  'utf8',
)

const TODAY = '2026-09-25'
const COACH_A = '10000000-0000-0000-0000-00000000000a'
const COACH_B = '10000000-0000-0000-0000-00000000000b'
const COACH_C = '10000000-0000-0000-0000-00000000000c'
const COACH_D = '10000000-0000-0000-0000-00000000000d'
const MASTER = '10000000-0000-0000-0000-0000000000ff'
const GONE = '10000000-0000-0000-0000-0000000000ee'

const BASE_SCHEMA = `
  CREATE ROLE anon NOLOGIN;
  CREATE ROLE authenticated NOLOGIN;
  CREATE ROLE service_role NOLOGIN BYPASSRLS;
  GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
  -- Supabase's default privileges: every new public table and function is
  -- granted to all three API roles. The migration must take the browser's away.
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;

  CREATE TABLE public.profiles (id uuid PRIMARY KEY, full_name text, deleted_at timestamptz);
  CREATE TABLE public.cron_heartbeats (
    name text PRIMARY KEY, last_ok_at timestamptz, expected_interval_seconds int,
    grace_seconds int, notes text
  );
`

const SEED = `
  INSERT INTO public.profiles (id, full_name, deleted_at) VALUES
    ('${COACH_A}', 'Coach A', NULL), ('${COACH_B}', 'Coach B', NULL),
    ('${COACH_C}', 'Coach C', NULL), ('${COACH_D}', 'Coach D', NULL),
    ('${MASTER}', 'Master M', NULL), ('${GONE}', 'Gone G', now());
`

let db
const runSql = (text) => db.exec(text)

async function asRole(role, sql, params = []) {
  await runSql(`SET ROLE ${role}`)
  try {
    return await db.query(sql, params)
  } finally {
    await runSql('RESET ROLE')
  }
}

async function save(profile, weekly, dated, { today = TODAY, actor = profile } = {}) {
  const res = await asRole(
    'service_role',
    'SELECT public.replace_staff_unavailability($1, $2, $3::date, $4::jsonb, $5::jsonb) AS r',
    [profile, actor, today, JSON.stringify(weekly), JSON.stringify(dated)],
  )
  return res.rows[0].r
}

const count = async (table, where) =>
  (await db.query(`SELECT count(*)::int AS n FROM public.${table} WHERE ${where}`)).rows[0].n

const MON_MORNING = { weekday: 'mon', all_day: false, start_time: '09:00', end_time: '12:00', note: null }
const OCT_3 = { start_date: '2026-10-03', end_date: '2026-10-03', all_day: true, start_time: null, end_time: null, note: 'Wedding' }

beforeAll(async () => {
  db = new PGlite()
  await runSql(BASE_SCHEMA)
  await runSql(MIGRATION)
  await runSql(SEED)
}, 60_000)

afterAll(async () => { await db?.close() })

describe('migration 630 — grants and posture', () => {
  it('anon and authenticated hold nothing on either table', async () => {
    for (const role of ['anon', 'authenticated']) {
      for (const table of ['staff_unavailability', 'staff_availability_changes']) {
        await expect(asRole(role, `SELECT 1 FROM public.${table}`)).rejects.toThrow(/permission denied/)
      }
    }
  })

  it('the browser roles cannot execute the RPC; service_role can', async () => {
    for (const role of ['anon', 'authenticated']) {
      await expect(asRole(role,
        `SELECT public.replace_staff_unavailability('${COACH_D}', '${COACH_D}', '${TODAY}', '[]', '[]')`,
      )).rejects.toThrow(/permission denied/)
    }
    await expect(save(COACH_D, [], [])).resolves.toMatchObject({ changed: false })
  })

  it('RLS is on and there are no policies (service-role only, like the 47 tables the advisor already lists)', async () => {
    const { rows } = await db.query(`
      SELECT relname, relrowsecurity FROM pg_class
       WHERE oid IN ('public.staff_unavailability'::regclass, 'public.staff_availability_changes'::regclass)
       ORDER BY relname`)
    expect(rows.map((r) => r.relrowsecurity)).toEqual([true, true])
    const policies = await db.query(`SELECT count(*)::int AS n FROM pg_policies
      WHERE schemaname = 'public' AND tablename IN ('staff_unavailability', 'staff_availability_changes')`)
    expect(policies.rows[0].n).toBe(0)
  })

  it('inserts the availability-notice-sweep heartbeat row (900s + 1800s grace)', async () => {
    const { rows } = await db.query(`SELECT expected_interval_seconds, grace_seconds FROM public.cron_heartbeats WHERE name = 'availability-notice-sweep'`)
    expect(rows).toEqual([{ expected_interval_seconds: 900, grace_seconds: 1800 }])
  })
})

describe('migration 630 — the rule CHECKs', () => {
  const insert = (cols) => runSql(`INSERT INTO public.staff_unavailability (profile_id, ${Object.keys(cols).join(', ')})
    VALUES ('${COACH_D}', ${Object.values(cols).map((v) => (v === null ? 'NULL' : `'${v}'`)).join(', ')})`)

  it('refuses a weekday that is not a mon..sun code', async () => {
    await expect(insert({ kind: 'weekly', weekday: 'monday', all_day: 'true' })).rejects.toThrow(/staff_unavailability_weekday/)
  })
  it('refuses a weekly rule carrying dates, and a dated rule with no dates', async () => {
    await expect(insert({ kind: 'weekly', weekday: 'mon', start_date: '2026-10-01', end_date: '2026-10-01', all_day: 'true' })).rejects.toThrow(/staff_unavailability_kind_shape/)
    await expect(insert({ kind: 'dated', all_day: 'true' })).rejects.toThrow(/staff_unavailability_kind_shape/)
  })
  it('refuses a range over 366 days and an end before the start', async () => {
    await expect(insert({ kind: 'dated', start_date: '2026-10-01', end_date: '2027-10-02', all_day: 'true' })).rejects.toThrow(/staff_unavailability_kind_shape/)
    await expect(insert({ kind: 'dated', start_date: '2026-10-02', end_date: '2026-10-01', all_day: 'true' })).rejects.toThrow(/staff_unavailability_kind_shape/)
  })
  it('refuses an end time at or before the start, and all_day with times', async () => {
    await expect(insert({ kind: 'weekly', weekday: 'mon', all_day: 'false', start_time: '12:00', end_time: '12:00' })).rejects.toThrow(/staff_unavailability_window/)
    await expect(insert({ kind: 'weekly', weekday: 'mon', all_day: 'true', start_time: '09:00', end_time: '10:00' })).rejects.toThrow(/staff_unavailability_window/)
  })
  it('refuses a note over 200 characters', async () => {
    await expect(insert({ kind: 'weekly', weekday: 'mon', all_day: 'true', note: 'x'.repeat(201) })).rejects.toThrow(/staff_unavailability_note/)
  })
})

describe('migration 630 — replace_staff_unavailability', () => {
  it('a first save writes the rules and ONE change row with before [] and the after snapshot', async () => {
    const r = await save(COACH_A, [MON_MORNING], [OCT_3])
    expect(r.changed).toBe(true)
    expect(r.change_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(r.before).toEqual([])
    expect(r.after).toEqual([
      { kind: 'dated', weekday: null, start_date: '2026-10-03', end_date: '2026-10-03', all_day: true, start_time: null, end_time: null, note: 'Wedding' },
      { kind: 'weekly', weekday: 'mon', start_date: null, end_date: null, all_day: false, start_time: '09:00', end_time: '12:00', note: null },
    ])
    expect(await count('staff_unavailability', `profile_id = '${COACH_A}'`)).toBe(2)
    expect(await count('staff_availability_changes', `profile_id = '${COACH_A}'`)).toBe(1)
  })

  it('saving the same set again is a no-op: changed false, no new change row, rows untouched', async () => {
    const ids = (await db.query(`SELECT id FROM public.staff_unavailability WHERE profile_id = '${COACH_A}' ORDER BY id`)).rows
    const r = await save(COACH_A, [MON_MORNING], [OCT_3])
    expect(r).toMatchObject({ changed: false, change_id: null })
    expect(await count('staff_availability_changes', `profile_id = '${COACH_A}'`)).toBe(1)
    expect((await db.query(`SELECT id FROM public.staff_unavailability WHERE profile_id = '${COACH_A}' ORDER BY id`)).rows).toEqual(ids)
  })

  it('all_day wins over any times sent with it, and duplicates collapse', async () => {
    const r = await save(COACH_B, [
      { weekday: 'tue', all_day: true, start_time: '09:00', end_time: '10:00' },
      { weekday: 'tue', all_day: true },
    ], [])
    expect(r.after).toEqual([{ kind: 'weekly', weekday: 'tue', start_date: null, end_date: null, all_day: true, start_time: null, end_time: null, note: null }])
  })

  it('a dated rule that ended before today is HISTORY: kept by a replace, never in before/after', async () => {
    await runSql(`INSERT INTO public.staff_unavailability (profile_id, kind, start_date, end_date, all_day)
      VALUES ('${COACH_C}', 'dated', '2026-09-01', '2026-09-02', true)`)
    const r = await save(COACH_C, [MON_MORNING], [])
    expect(r.before).toEqual([])
    expect(await count('staff_unavailability', `profile_id = '${COACH_C}' AND end_date = '2026-09-02'`)).toBe(1)
    await save(COACH_C, [], [])
    expect(await count('staff_unavailability', `profile_id = '${COACH_C}'`)).toBe(1) // only the history row
  })

  it('a dated rule running through today is current: replaced like any other (its elapsed days stay as history)', async () => {
    await save(COACH_D, [], [{ start_date: '2026-09-20', end_date: '2026-09-27', all_day: true }], { today: '2026-09-20' })
    const r = await save(COACH_D, [], [])
    expect(r.before).toHaveLength(1)
    expect(await count('staff_unavailability', `profile_id = '${COACH_D}' AND end_date >= '${TODAY}'`)).toBe(0)
  })

  it('deleting a STARTED rule keeps the days already gone: start..yesterday stays as history, window and note included', async () => {
    const F = '10000000-0000-0000-0000-0000000000f1'
    await runSql(`INSERT INTO public.profiles (id, full_name) VALUES ('${F}', 'Coach F')`)
    const rule = { start_date: '2026-09-20', end_date: '2026-09-30', all_day: false, start_time: '09:00', end_time: '12:00', note: 'Course' }
    await save(F, [], [rule], { today: '2026-09-20' })
    await save(F, [], [])
    const { rows } = await db.query(`SELECT start_date::text, end_date::text, all_day, left(start_time::text, 5) AS s, left(end_time::text, 5) AS e, note
      FROM public.staff_unavailability WHERE profile_id = $1 ORDER BY start_date`, [F])
    expect(rows).toEqual([{ start_date: '2026-09-20', end_date: '2026-09-24', all_day: false, s: '09:00', e: '12:00', note: 'Course' }])
  })

  it('shortening a started rule (old one out, the rest from today in) keeps the elapsed part too', async () => {
    const G = '10000000-0000-0000-0000-0000000000f2'
    await runSql(`INSERT INTO public.profiles (id, full_name) VALUES ('${G}', 'Coach G')`)
    await save(G, [], [{ start_date: '2026-09-20', end_date: '2026-09-30', all_day: true }], { today: '2026-09-20' })
    await save(G, [], [{ start_date: '2026-09-25', end_date: '2026-09-27', all_day: true }])
    const { rows } = await db.query(`SELECT start_date::text, end_date::text FROM public.staff_unavailability WHERE profile_id = $1 ORDER BY start_date`, [G])
    expect(rows).toEqual([{ start_date: '2026-09-20', end_date: '2026-09-24' }, { start_date: '2026-09-25', end_date: '2026-09-27' }])
  })

  it('a started rule kept as it is (or with only its note changed) is not split', async () => {
    const H = '10000000-0000-0000-0000-0000000000f3'
    await runSql(`INSERT INTO public.profiles (id, full_name) VALUES ('${H}', 'Coach H')`)
    const rule = { start_date: '2026-09-20', end_date: '2026-09-30', all_day: true, note: 'a' }
    await save(H, [], [rule], { today: '2026-09-20' })
    await save(H, [{ weekday: 'mon', all_day: true }], [rule])
    await save(H, [{ weekday: 'mon', all_day: true }], [{ ...rule, note: 'b' }])
    const { rows } = await db.query(`SELECT start_date::text, end_date::text, note FROM public.staff_unavailability WHERE profile_id = $1 AND kind = 'dated'`, [H])
    expect(rows).toEqual([{ start_date: '2026-09-20', end_date: '2026-09-30', note: 'b' }])
  })

  it('refuses to ADD a date that has passed, and writes nothing', async () => {
    const before = await count('staff_availability_changes', `profile_id = '${COACH_B}'`)
    await expect(save(COACH_B, [], [{ start_date: '2026-09-01', end_date: '2026-09-02', all_day: true }]))
      .rejects.toThrow(/availability_past_date/)
    expect(await count('staff_availability_changes', `profile_id = '${COACH_B}'`)).toBe(before)
  })

  it('refuses a NEW or CHANGED rule that starts before today; an unchanged started rule (a note edit too) is fine', async () => {
    const E = '10000000-0000-0000-0000-0000000000e1'
    await runSql(`INSERT INTO public.profiles (id, full_name) VALUES ('${E}', 'Coach E')`)
    const rule = { start_date: '2026-09-20', end_date: '2026-09-30', all_day: true, note: 'Trip' }
    await save(E, [], [rule], { today: '2026-09-20' })
    await expect(save(E, [], [{ ...rule, end_date: '2026-09-29' }])).rejects.toThrow(/availability_past_start/)
    await expect(save(E, [], [rule, { start_date: '2026-09-01', end_date: '2026-09-26', all_day: true }])).rejects.toThrow(/availability_past_start/)
    await expect(save(E, [], [rule])).resolves.toMatchObject({ changed: false })
    await expect(save(E, [], [{ ...rule, note: 'Trip, edited' }])).resolves.toMatchObject({ changed: true })
  })

  it('a malformed rule aborts the whole save: the old set survives', async () => {
    const before = await count('staff_unavailability', `profile_id = '${COACH_A}'`)
    await expect(save(COACH_A, [{ weekday: 'mon', all_day: false, start_time: '12:00', end_time: '09:00' }], []))
      .rejects.toThrow(/staff_unavailability_window/)
    expect(await count('staff_unavailability', `profile_id = '${COACH_A}'`)).toBe(before)
  })

  it('records the actor (a master under View as user) separately from the person', async () => {
    const r = await save(COACH_B, [{ weekday: 'fri', all_day: true }], [], { actor: MASTER })
    const { rows } = await db.query(`SELECT profile_id, actor_id FROM public.staff_availability_changes WHERE id = $1`, [r.change_id])
    expect(rows).toEqual([{ profile_id: COACH_B, actor_id: MASTER }])
  })

  it('refuses a tombstoned profile and non-array arguments', async () => {
    await expect(save(GONE, [], [])).rejects.toThrow(/availability_no_profile/)
    await expect(asRole('service_role',
      `SELECT public.replace_staff_unavailability('${COACH_A}', '${COACH_A}', '${TODAY}', '{}'::jsonb, '[]'::jsonb)`,
    )).rejects.toThrow(/availability_bad_args/)
  })

  it('a change row starts un-notified; notified_at and notice_outcome move together', async () => {
    expect(await count('staff_availability_changes', 'notified_at IS NULL')).toBeGreaterThan(0)
    await expect(runSql(`UPDATE public.staff_availability_changes SET notified_at = now() WHERE notice_outcome IS NULL`))
      .rejects.toThrow(/staff_availability_changes_notice_pair/)
    await expect(runSql(`UPDATE public.staff_availability_changes SET notified_at = now(), notice_outcome = 'maybe'`))
      .rejects.toThrow(/staff_availability_changes_notice_outcome/)
  })
})
