// HOLIDAYLEAVE.1 — behavioural test for the operator-run data correction in
// docs/runbooks/holidayleave-1-bank-holiday-correction.md.
//
// Same approach as the migration-61x tests: boot an in-process Postgres
// (PGlite). The SQL under test is READ FROM THE RUNBOOK, so the text tested is
// the text the operator runs. The tables, the allowance trigger and its
// function are the REAL definitions lifted from the migration files (011 tables
// + trigger, 017 location_holidays, 616 function); only `locations`,
// `profiles` and `profile_compensation` are minimal stand-ins. Every request is
// inserted pending and then moved to its final status, as the app does, so the
// real trigger builds `staff_allowances` exactly as production did.
//
// What this CANNOT show: PGlite is one connection, so a genuinely in-flight
// approval (another transaction committing between this statement's snapshot
// and its row lock) cannot be staged. The sequential half is tested below; the
// in-flight half rests on the UPDATE's re-checked guards, which are asserted
// structurally and argued in the runbook.

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { getStaticHolidays } from '../src/lib/bank-holidays'

const root = path.resolve(import.meta.dirname, '..')
const mig = (f) => readFileSync(path.join(root, 'supabase/migrations', f), 'utf8')
const RUNBOOK = readFileSync(path.join(root, 'docs/runbooks/holidayleave-1-bank-holiday-correction.md'), 'utf8')

const SQL_BLOCKS = [...RUNBOOK.matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => m[1])
const [DRY_RAW, APPLY_RAW] = SQL_BLOCKS
const DEPLOY_TS = "'2026-09-25T12:00:00Z'::timestamptz"
const withDeployTs = (sql) => sql.replaceAll(':deploy_ts', DEPLOY_TS)

function statement(sql, re, what) {
  const m = sql.match(re)
  if (!m) throw new Error(`could not find ${what} in the migration file`)
  return m[0]
}
const MIG_011 = mig('011_time_off.sql')
const MIG_017 = mig('017_location_holidays.sql')
const MIG_616 = mig('616_time_off_created_by_allowance_seed.sql')
const REAL_DDL = [
  statement(MIG_011, /CREATE TABLE staff_allowances \([\s\S]*?\n\);/, 'staff_allowances'),
  statement(MIG_011, /CREATE TABLE time_off_requests \([\s\S]*?\n\);/, 'time_off_requests'),
  statement(MIG_017, /CREATE TABLE location_holidays \([\s\S]*?\n\);/, 'location_holidays'),
].join('\n')
const REAL_TRIGGER = statement(MIG_011, /CREATE TRIGGER trg_update_holiday_allowance[\s\S]*?;/, 'the allowance trigger')

const IE = 'a0000000-0000-0000-0000-000000000001'
const IE_NULL = 'a0000000-0000-0000-0000-000000000002' // country not on file = Ireland, as the route
const GB = 'a0000000-0000-0000-0000-000000000003'
const P = (n) => `10000000-0000-0000-0000-00000000000${n}`
const BEFORE = '2026-05-01T09:00:00Z' // filed before the deploy
const AFTER = '2026-10-01T09:00:00Z' // filed after it

// key → [profile, studio, type, start, end, total_days as stored, final status, created_at]
const REQUESTS = {
  // Coach 1 — the plain cases.
  juneBankHolidayWeek: [P(1), IE, 'holiday', '2026-06-01', '2026-06-05', 5, 'approved', BEFORE],
  closureWeek: [P(1), IE, 'holiday', '2026-06-08', '2026-06-12', 5, 'approved', BEFORE],
  plainWeek: [P(1), IE, 'holiday', '2026-07-06', '2026-07-10', 5, 'approved', BEFORE],
  // Coach 2 — statuses and types that must be left alone, and one pending.
  pendingOctober: [P(2), IE, 'holiday', '2026-10-26', '2026-10-30', 5, 'pending', BEFORE],
  handEdited: [P(2), IE, 'holiday', '2026-08-03', '2026-08-07', 3, 'approved', BEFORE],
  rejected: [P(2), IE, 'holiday', '2026-03-16', '2026-03-20', 5, 'rejected', BEFORE],
  sick: [P(2), IE, 'sick', '2026-05-04', '2026-05-08', 5, 'approved', BEFORE],
  cancelled: [P(2), IE, 'holiday', '2026-04-06', '2026-04-10', 5, 'cancelled', BEFORE],
  // Coach 3 — a contractor has no allowance.
  contractor: [P(3), IE, 'holiday', '2026-06-01', '2026-06-05', 5, 'pending', BEFORE],
  // Coach 4 — employment_type NULL (= fte), studio with no country on file.
  onlyABankHoliday: [P(4), IE_NULL, 'holiday', '2026-03-17', '2026-03-17', 1, 'approved', BEFORE],
  otherStudiosClosure: [P(4), IE_NULL, 'holiday', '2026-06-15', '2026-06-19', 5, 'approved', BEFORE],
  // Coach 5 — another country, Christmas, a legacy straddler, and 2027.
  gbStudio: [P(5), GB, 'holiday', '2026-06-01', '2026-06-05', 5, 'approved', BEFORE],
  christmasWeek: [P(5), IE, 'holiday', '2026-12-21', '2026-12-27', 5, 'approved', BEFORE],
  legacyStraddler: [P(5), IE, 'holiday', '2025-12-29', '2026-01-02', 5, 'approved', BEFORE],
  january2027: [P(5), IE, 'holiday', '2027-01-01', '2027-01-08', 6, 'approved', BEFORE],
  pendingMarch2027: [P(5), IE, 'holiday', '2027-03-15', '2027-03-19', 5, 'pending', BEFORE],
  // Coach 6 — filed AFTER the deploy (counted by the new code), and a closure
  // added after an old request.
  postDeployThenClosure: [P(6), IE, 'holiday', '2026-11-09', '2026-11-13', 5, 'approved', AFTER],
  postDeployAlreadyRight: [P(6), IE, 'holiday', '2026-12-21', '2026-12-25', 4, 'approved', AFTER],
  closureAddedLater: [P(6), IE, 'holiday', '2026-02-02', '2026-02-06', 5, 'approved', '2026-01-10T09:00:00Z'],
  // Coach 8 — past the years this runbook carries a bank-holiday list for.
  year2028: [P(8), IE, 'holiday', '2028-01-03', '2028-01-07', 5, 'pending', BEFORE],
}
// Coach 7 — approved with NO allowance row (inserted approved, so the AFTER
// UPDATE trigger never ran). Nothing to hand a day back to.
const NO_ALLOWANCE_ROW = [P(7), IE, 'holiday', '2026-05-04', '2026-05-08', 5, 'approved', BEFORE]

let db
const ids = {}

async function file(key, [profile, studio, type, start, end, days, status, createdAt], { direct = false } = {}) {
  const { rows } = await db.query(
    `INSERT INTO public.time_off_requests (profile_id, location_id, type, start_date, end_date, total_days, status, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [profile, studio, type, start, end, days, direct ? status : 'pending', createdAt],
  )
  ids[key] = rows[0].id
  if (!direct && status === 'cancelled') await setStatus(key, 'approved')
  if (!direct && status !== 'pending') await setStatus(key, status)
}
const setStatus = (key, status) => db.query('UPDATE public.time_off_requests SET status = $1 WHERE id = $2', [status, ids[key]])

async function totals() {
  const { rows } = await db.query('SELECT id, total_days::float AS days FROM public.time_off_requests')
  return Object.fromEntries(Object.entries(ids).map(([key, id]) => [key, rows.find((r) => r.id === id).days]))
}
async function used() {
  const { rows } = await db.query('SELECT profile_id, year, used_days::float AS used FROM public.staff_allowances')
  return Object.fromEntries(rows.map((r) => [`coach${r.profile_id.slice(-1)}/${r.year}`, r.used]))
}
const dryRun = async () => (await db.query(withDeployTs(DRY_RAW))).rows
const apply = async () => {
  const [row] = (await db.query(withDeployTs(APPLY_RAW))).rows
  return Object.fromEntries(Object.entries(row).map(([k, v]) => [k, Number(v)]))
}
const keyOf = (id) => Object.keys(ids).find((k) => ids[k] === id)

beforeAll(async () => {
  db = new PGlite()
  await db.exec(`
    CREATE TABLE public.locations (id uuid PRIMARY KEY, country char(2));
    CREATE TABLE public.profiles (id uuid PRIMARY KEY, full_name text, employment_type text);
    CREATE TABLE public.profile_compensation (profile_id uuid PRIMARY KEY, annual_leave_entitlement numeric);
  `)
  await db.exec(REAL_DDL)
  await db.exec(MIG_616)
  await db.exec(REAL_TRIGGER)
})

beforeEach(async () => {
  await db.exec(`
    TRUNCATE public.time_off_requests, public.staff_allowances, public.location_holidays, public.profiles, public.locations CASCADE;
    INSERT INTO public.locations VALUES ('${IE}', 'IE'), ('${IE_NULL}', NULL), ('${GB}', 'GB');
    INSERT INTO public.profiles VALUES
      ('${P(1)}', 'Coach 1', 'fte'), ('${P(2)}', 'Coach 2', 'fte'), ('${P(3)}', 'Coach 3', 'contractor'),
      ('${P(4)}', 'Coach 4', NULL), ('${P(5)}', 'Coach 5', 'fte'), ('${P(6)}', 'Coach 6', 'fte'),
      ('${P(7)}', 'Coach 7', 'fte'), ('${P(8)}', 'Coach 8', 'fte');
    INSERT INTO public.location_holidays (location_id, date, name, created_at) VALUES
      ('${IE}', '2026-06-10', 'Studio closed', '2026-01-05T09:00:00Z'),
      ('${GB}', '2026-06-17', 'Other studio closed', '2026-01-05T09:00:00Z'),
      ('${IE}', '2026-02-04', 'Closed, added after the request', '2026-01-20T09:00:00Z'),
      ('${IE}', '2026-11-11', 'Closed, added after a post-deploy request', '2026-10-05T09:00:00Z'),
      ('${IE}', '2028-01-05', 'Studio closed', '2026-01-05T09:00:00Z');
  `)
  for (const k of Object.keys(ids)) delete ids[k]
  for (const [key, row] of Object.entries(REQUESTS)) await file(key, row)
  await file('noAllowanceRow', NO_ALLOWANCE_ROW, { direct: true })
})

afterAll(async () => { await db?.close() })

const CORRECTED = {
  juneBankHolidayWeek: 4, closureWeek: 4, pendingOctober: 4, onlyABankHoliday: 0,
  christmasWeek: 4, january2027: 5, pendingMarch2027: 4, closureAddedLater: 3,
}

describe('the runbook itself', () => {
  it('carries exactly two SQL statements, both scoped by the same :deploy_ts placeholder', () => {
    expect(SQL_BLOCKS).toHaveLength(2)
    for (const sql of SQL_BLOCKS) expect(sql).toMatch(/r\.created_at < :deploy_ts/)
  })

  it('refuses to run until :deploy_ts has been substituted', async () => {
    await expect(db.query(DRY_RAW)).rejects.toThrow()
    await expect(db.query(APPLY_RAW)).rejects.toThrow()
    expect(await totals()).toMatchObject({ juneBankHolidayWeek: 5 })
  })

  it('the dry run writes nothing; the apply is ONE statement with no transaction control', () => {
    expect(DRY_RAW).not.toMatch(/\b(UPDATE|INSERT|DELETE)\b/i)
    expect(APPLY_RAW.trim().replace(/;$/, '')).not.toMatch(/;/)
    expect(APPLY_RAW).not.toMatch(/\b(BEGIN|COMMIT)\b/i)
  })

  it('both statements embed the app\'s own Irish bank-holiday list for 2026-2027', () => {
    const app = getStaticHolidays('2026-01-01', '2027-12-31', 'IE').map((h) => h.date)
    for (const sql of SQL_BLOCKS) {
      const bank = sql.slice(sql.indexOf('bank(d) AS ('), sql.indexOf('candidates AS ('))
      expect([...bank.matchAll(/'(\d{4}-\d{2}-\d{2})'/g)].map((m) => m[1])).toEqual(app)
    }
  })

  it('hands days back by the status the UPDATE saw, behind guards re-checked on the locked row', () => {
    expect(APPLY_RAW).toMatch(/RETURNING[^)]*\br\.status\b/)
    expect(APPLY_RAW).not.toMatch(/RETURNING[^)]*\bf\.status\b/)
    expect(APPLY_RAW).toMatch(/r\.status = f\.status/)
    expect(APPLY_RAW).toMatch(/r\.total_days = f\.total_days/)
  })
})

describe('the correction', () => {
  it('the fixture is what production looks like: the old count, charged by the real trigger', async () => {
    expect(await used()).toEqual({
      'coach1/2026': 15, 'coach2/2026': 3, 'coach4/2026': 6,
      'coach5/2025': 5, 'coach5/2026': 10, 'coach5/2027': 6, 'coach6/2026': 14,
    })
  })

  it('first apply corrects exactly the expected rows and hands back exactly those days', async () => {
    const before = await totals()
    const result = await apply()
    expect(result).toEqual({
      requests_corrected: 8, of_which_pending: 2, allowance_days_returned: 7,
      allowance_rows_updated: 5, skipped_changed_underneath: 0,
    })
    expect(await totals()).toEqual({ ...before, ...CORRECTED })
    expect(await used()).toEqual({
      'coach1/2026': 13, // two requests, a day each
      'coach2/2026': 3, // its only correction is PENDING: never charged, nothing to return
      'coach4/2026': 5,
      'coach5/2025': 5, 'coach5/2026': 9, 'coach5/2027': 5, // each year's row gets its own day
      'coach6/2026': 12, // bank holiday + a closure
    })
  })

  it('second apply changes nothing', async () => {
    await apply()
    const [days, allowances] = [await totals(), await used()]
    expect(await apply()).toEqual({
      requests_corrected: 0, of_which_pending: 0, allowance_days_returned: 0,
      allowance_rows_updated: 0, skipped_changed_underneath: 0,
    })
    expect(await totals()).toEqual(days)
    expect(await used()).toEqual(allowances)
    expect((await dryRun()).filter((r) => r.will_fix)).toEqual([])
  })

  it('a request filed after the deploy is never touched, even once a closure lands inside it', async () => {
    // Counted correctly by the new code (5: no closure existed yet). The closure
    // added later makes it LOOK like the old formula's answer.
    await apply()
    await db.query(`INSERT INTO public.location_holidays (location_id, date, name) VALUES ('${IE}', '2026-11-12', 'Another late closure')`)
    expect((await apply()).requests_corrected).toBe(0)
    expect(await totals()).toMatchObject({ postDeployThenClosure: 5, postDeployAlreadyRight: 4 })
    expect((await dryRun()).map((r) => keyOf(r.id))).not.toContain('postDeployThenClosure')
  })

  it('leaves alone: contractor, another country, hand-edited, rejected, cancelled, sick, another studio\'s closure, no allowance row, a straddler, 2028', async () => {
    await apply()
    expect(await totals()).toMatchObject({
      contractor: 5, gbStudio: 5, handEdited: 3, rejected: 5, cancelled: 5, sick: 5,
      otherStudiosClosure: 5, noAllowanceRow: 5, legacyStraddler: 5, year2028: 5, plainWeek: 5,
    })
  })

  it('a pending request approved between the dry run and the apply ends consistent', async () => {
    const seen = (await dryRun()).find((r) => keyOf(r.id) === 'pendingOctober')
    expect(seen).toMatchObject({ status: 'pending', will_fix: true })
    await setStatus('pendingOctober', 'approved') // the real trigger charges the OLD 5
    expect((await used())['coach2/2026']).toBe(8)
    const result = await apply()
    expect(result.of_which_pending).toBe(1) // only the 2027 one is still pending
    expect(await totals()).toMatchObject({ pendingOctober: 4 })
    expect((await used())['coach2/2026']).toBe(7) // 3 + the 4 days it really costs
  })

  it('an approved request cancelled between the dry run and the apply ends consistent', async () => {
    await dryRun()
    await setStatus('juneBankHolidayWeek', 'cancelled') // the real trigger returns the OLD 5
    await apply()
    expect(await totals()).toMatchObject({ juneBankHolidayWeek: 5 })
    expect((await used())['coach1/2026']).toBe(9) // 15 - 5 cancelled - 1 for closureWeek
  })
})

describe('the dry run', () => {
  it('marks will_fix on exactly the rows the apply then changes', async () => {
    const rows = await dryRun()
    const before = await totals()
    await apply()
    const after = await totals()
    const changed = Object.keys(after).filter((k) => after[k] !== before[k]).sort()
    expect(rows.filter((r) => r.will_fix).map((r) => keyOf(r.id)).sort()).toEqual(changed)
    expect(changed).toEqual(Object.keys(CORRECTED).sort())
    for (const r of rows.filter((x) => x.will_fix)) expect(Number(r.proposed_total_days)).toBe(CORRECTED[keyOf(r.id)])
  })

  it('shows WHICH dates: bank holidays, closures, and closures added after the request was filed', async () => {
    const byKey = Object.fromEntries((await dryRun()).map((r) => [keyOf(r.id), r]))
    expect(byKey.juneBankHolidayWeek).toMatchObject({ bank_dates: ['2026-06-01'], closure_dates: [], closures_added_after_request: [] })
    expect(byKey.closureWeek).toMatchObject({ bank_dates: [], closure_dates: ['2026-06-10'], closures_added_after_request: [] })
    expect(byKey.closureAddedLater).toMatchObject({
      bank_dates: ['2026-02-02'], closure_dates: ['2026-02-04'], closures_added_after_request: ['2026-02-04'],
    })
    // Sat 26 Dec is in the list but was never charged: weekdays only.
    expect(byKey.christmasWeek.bank_dates).toEqual(['2026-12-25'])
  })

  it('shows each allowance before and after, per person and YEAR', async () => {
    const byKey = Object.fromEntries((await dryRun()).map((r) => [keyOf(r.id), r]))
    expect(Number(byKey.juneBankHolidayWeek.allowance_used_days_now)).toBe(15)
    expect(Number(byKey.juneBankHolidayWeek.allowance_used_days_after)).toBe(13)
    expect(Number(byKey.january2027.allowance_used_days_now)).toBe(6)
    expect(Number(byKey.january2027.allowance_used_days_after)).toBe(5)
    expect(Number(byKey.pendingOctober.allowance_used_days_after)).toBe(3) // pending: nothing to return
  })

  it('reports, without fixing, what needs a person', async () => {
    const note = Object.fromEntries((await dryRun()).map((r) => [keyOf(r.id), r.note]))
    expect(note.contractor).toMatch(/contractor/)
    expect(note.legacyStraddler).toMatch(/straddles a year/)
    expect(note.year2028).toMatch(/after 2027/)
    expect(note.handEdited).toMatch(/not the old Mon-Fri count/)
    expect(note.noAllowanceRow).toMatch(/no allowance row/)
    expect(note.juneBankHolidayWeek).toMatch(/will be corrected/)
    await apply()
    const after = Object.fromEntries((await dryRun()).map((r) => [keyOf(r.id), r.note]))
    expect(after.juneBankHolidayWeek).toMatch(/already correct/)
  })
})
