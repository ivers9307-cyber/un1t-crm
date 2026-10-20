// LIEU.1 — the nightly lieu sweep on a fake builder that applies eq / in /
// gte / lte / range the way PostgREST would: one credit per shift
// assignment, cancelled shifts excluded, contractors excluded, tombstoned
// staff credited (history), a shift that has not ended yet skipped until it
// has, an existing credit never doubled, the studio's multiplier and country
// honoured, and the failure posture (one studio down ≠ the sweep down).
import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logInfo: vi.fn(), logError: vi.fn() }))

import {
  runLieuCreditSweep, lieuCreditRowsFor, shiftEndInstant, getLieuBalance, readLieuLedgerForProfiles,
} from './lieu-credits'

const LOC_A = 'a0000000-0000-0000-0000-000000000001'
const LOC_B = 'b0000000-0000-0000-0000-000000000002'
const ZONE = 'Europe/Dublin'

// Sun 7 Jun 2026 09:00-17:00 Dublin. "Now" is Mon 8 Jun 03:40 UTC (the cron's slot).
const NOW = Date.parse('2026-06-08T03:40:00Z')

function assignment(id, over = {}) {
  const blocks = {
    block_date: '2026-06-07', start_time: '09:00:00', end_time: '17:00:00', location_id: LOC_A,
    shift_templates: { name: 'Day', start_time: '09:00:00', end_time: '17:00:00' },
    ...(over.shift_blocks || {}),
  }
  return {
    id, profile_id: 'p1', start_time_override: null, end_time_override: null, status: 'scheduled', arrived_at: null,
    profiles: { full_name: 'Anna', role: 'staff', deleted_role: null, employment_type: 'fte' },
    ...over,
    shift_blocks: blocks,
    'shift_blocks.location_id': blocks.location_id,
    'shift_blocks.block_date': blocks.block_date,
  }
}

function fakeDb(tables, { fail = null } = {}) {
  const writes = []
  return {
    writes,
    from(table) {
      const preds = []
      let rangeArg = null
      let upserted = null
      const b = {
        select() { return b },
        eq(col, v) { preds.push((r) => r[col] === v); return b },
        in(col, vs) { preds.push((r) => vs.includes(r[col])); return b },
        gte(col, v) { preds.push((r) => r[col] >= v); return b },
        lte(col, v) { preds.push((r) => r[col] <= v); return b },
        order() { return b },
        range(a, z) { rangeArg = [a, z]; return b },
        upsert(rows, opts) {
          upserted = { rows, opts }
          return b
        },
        then(onF, onR) {
          if (fail === table) return Promise.resolve({ data: null, error: { message: `${table} down` } }).then(onF, onR)
          if (upserted) {
            writes.push({ table, ...upserted })
            const have = new Set((tables[table] || []).map((r) => r.shift_assignment_id))
            const fresh = upserted.rows.filter((r) => !have.has(r.shift_assignment_id))
            ;(tables[table] ||= []).push(...fresh.map((r, i) => ({ id: `new-${i}`, ...r })))
            return Promise.resolve({ data: fresh.map((r, i) => ({ id: `new-${i}` })), error: null }).then(onF, onR)
          }
          let rows = (tables[table] || []).filter((r) => preds.every((p) => p(r)))
          if (rangeArg) rows = rows.slice(rangeArg[0], rangeArg[1] + 1)
          return Promise.resolve({ data: rows, error: null }).then(onF, onR)
        },
      }
      return b
    },
  }
}

const LOCATIONS = [
  { id: LOC_A, country: 'IE', timezone: ZONE, settings: null },
  { id: LOC_B, country: 'IE', timezone: ZONE, settings: { payroll: { sunday_multiplier: 1.5 } } },
]

describe('shiftEndInstant', () => {
  it('is the paid window end on the studio clock; overnight ends next day; 24:00 is midnight', () => {
    const s = { shift_date: '2026-06-07', block_start_time: '09:00:00', block_end_time: '17:00:00' }
    expect(shiftEndInstant(s, ZONE)).toBe(Date.parse('2026-06-07T16:00:00Z'))         // IST = UTC+1
    expect(shiftEndInstant({ ...s, block_start_time: '22:00:00', block_end_time: '02:00:00' }, ZONE)).toBe(Date.parse('2026-06-08T01:00:00Z'))
    expect(shiftEndInstant({ ...s, block_end_time: '24:00:00' }, ZONE)).toBe(Date.parse('2026-06-07T23:00:00Z'))
    expect(shiftEndInstant({ ...s, block_end_time: 'x' }, ZONE)).toBeNull()
    expect(shiftEndInstant({ ...s, shift_date: null }, ZONE)).toBeNull()
  })
})

describe('lieuCreditRowsFor (pure)', () => {
  const base = { locationId: LOC_A, zone: ZONE, holidaysByDate: new Map(), sundayMultiplier: 4 / 3, existingAssignmentIds: new Set(), nowMs: NOW }
  const row = (over) => ({
    assignment_id: 'as1', profile_id: 'p1', shift_date: '2026-06-07', status: 'scheduled',
    start_time_override: null, end_time_override: null, block_start_time: '09:00:00', block_end_time: '17:00:00',
    profiles: { employment_type: 'fte' }, shift_templates: null, ...over,
  })

  it('builds one credit row per due, ended, uncredited shift', () => {
    const { rows, skipped } = lieuCreditRowsFor({ ...base, shifts: [row()] })
    expect(rows).toEqual([{
      profile_id: 'p1', location_id: LOC_A, source: 'sunday_worked', shift_assignment_id: 'as1', credit_date: '2026-06-07',
      hours: 10.67, worked_hours: 8, multiplier: 1.3333, holiday_name: null, note: null, created_by: null,
    }])
    expect(skipped).toEqual({ existing: 0, not_ended: 0, not_due: 0 })
  })
  it('skips an already-credited assignment, a shift still running, and one that earns nothing', () => {
    const { rows, skipped } = lieuCreditRowsFor({
      ...base,
      existingAssignmentIds: new Set(['as1']),
      shifts: [
        row(),
        row({ assignment_id: 'as2', shift_date: '2026-06-08' }),                                    // Monday, not due
        row({ assignment_id: 'as3', shift_date: '2026-06-07', block_end_time: '17:00:00' }),         // ended → in
        row({ assignment_id: 'as4', shift_date: '2026-06-14' }),                                     // next Sunday, not ended
        row({ assignment_id: 'as5', status: 'cancelled' }),                                          // cancelled → not due
        row({ assignment_id: 'as6', profiles: { employment_type: 'contractor' } }),                  // contractor → not due
      ],
    })
    expect(rows.map((r) => r.shift_assignment_id)).toEqual(['as3'])
    expect(skipped).toEqual({ existing: 1, not_ended: 1, not_due: 3 })
  })
  it('names the public holiday and applies the greater multiplier when it is a Sunday', () => {
    const { rows } = lieuCreditRowsFor({
      ...base, nowMs: Date.parse('2027-12-27T03:40:00Z'),
      holidaysByDate: new Map([['2027-12-26', "St Stephen's Day"]]),
      shifts: [row({ shift_date: '2027-12-26' })],
    })
    expect(rows[0]).toMatchObject({ source: 'public_holiday_worked', holiday_name: "St Stephen's Day", hours: 10.67 })
  })
})

describe('runLieuCreditSweep', () => {
  it('credits each completed Sunday / holiday FTE shift once, at the studio multiplier, tombstones included', async () => {
    const tables = {
      locations: LOCATIONS,
      shift_assignments: [
        assignment('as1'),                                                                                // Sunday, Anna, loc A
        assignment('as2', { status: 'cancelled' }),                                                       // cancelled
        assignment('as3', { profile_id: 'p2', profiles: { employment_type: 'contractor' } }),             // contractor
        assignment('as4', { profile_id: 'p3', profiles: { employment_type: 'fte', deleted_role: 'manager' },
          shift_blocks: { block_date: '2026-06-01', location_id: LOC_B } }),                               // June bank holiday, tombstone, loc B
        assignment('as5', { shift_blocks: { block_date: '2026-06-07', location_id: LOC_B } }),             // Sunday at loc B (×1.5)
        assignment('as6', { shift_blocks: { block_date: '2026-06-03', location_id: LOC_A } }),             // Wednesday
        assignment('as7', { shift_blocks: { block_date: '2026-06-14', location_id: LOC_A } }),             // next Sunday (future)
      ],
      staff_lieu_credits: [{ id: 'old', profile_id: 'p1', shift_assignment_id: 'as1', credit_date: '2026-06-07', hours: 10.67 }],
    }
    const db = fakeDb(tables)
    const stats = await runLieuCreditSweep(db, { nowMs: NOW })
    expect(stats.ok).toBe(true)
    expect(stats).toMatchObject({ locations: 2, candidates: 3, inserted: 2, skipped_existing: 1, skipped_not_ended: 0, failed: 0 })
    const written = db.writes.flatMap((w) => w.rows)
    expect(written.map((r) => [r.shift_assignment_id, r.source, r.hours, r.multiplier, r.holiday_name])).toEqual([
      ['as4', 'public_holiday_worked', 8, 1, 'June Public Holiday'],
      ['as5', 'sunday_worked', 12, 1.5, null],
    ])
    expect(db.writes[0].opts).toEqual({ onConflict: 'shift_assignment_id', ignoreDuplicates: true })
    // the existing credit for as1 was neither doubled nor rewritten
    expect(tables.staff_lieu_credits.filter((r) => r.shift_assignment_id === 'as1')).toHaveLength(1)
  })

  it('a second run on the same night credits nothing more', async () => {
    const tables = { locations: LOCATIONS, shift_assignments: [assignment('as1')], staff_lieu_credits: [] }
    const db = fakeDb(tables)
    expect((await runLieuCreditSweep(db, { nowMs: NOW })).inserted).toBe(1)
    const again = await runLieuCreditSweep(db, { nowMs: NOW })
    expect(again).toMatchObject({ inserted: 0, skipped_existing: 1, candidates: 1 })
    expect(tables.staff_lieu_credits).toHaveLength(1)
  })

  it('a shift that has not ended yet is left for the next night', async () => {
    const tables = { locations: LOCATIONS, shift_assignments: [assignment('as1')], staff_lieu_credits: [] }
    const db = fakeDb(tables)
    const stats = await runLieuCreditSweep(db, { nowMs: Date.parse('2026-06-07T12:00:00Z') })
    expect(stats).toMatchObject({ inserted: 0, skipped_not_ended: 1 })
    expect(db.writes).toEqual([])
  })

  it('a failed locations read is a failed sweep (ok: false), nothing written', async () => {
    const db = fakeDb({ locations: LOCATIONS }, { fail: 'locations' })
    const stats = await runLieuCreditSweep(db, { nowMs: NOW })
    expect(stats.ok).toBe(false)
    expect(stats.error).toMatch(/locations down/)
  })

  it('one studio failing is counted and the rest still run; every studio failing is ok: false', async () => {
    const tables = { locations: LOCATIONS, shift_assignments: [assignment('as1')], staff_lieu_credits: [] }
    const db = fakeDb(tables, { fail: 'shift_assignments' })
    const stats = await runLieuCreditSweep(db, { nowMs: NOW })
    expect(stats.ok).toBe(false)
    expect(stats.failed).toBe(2)
    expect(stats.failures.map((f) => f.step)).toEqual(['shifts', 'shifts'])

    const one = fakeDb({ locations: [LOCATIONS[0]], shift_assignments: [assignment('as1')], staff_lieu_credits: [] }, { fail: 'staff_lieu_credits' })
    const partial = await runLieuCreditSweep(one, { nowMs: NOW })
    expect(partial.ok).toBe(false)           // the only studio failed its ledger read
    expect(partial.failures[0].step).toBe('ledger')
  })

  it('a wider lookback credits older shifts (the hand-run backfill), capped at 400 days', async () => {
    const tables = {
      locations: [LOCATIONS[0]],
      shift_assignments: [assignment('as1', { shift_blocks: { block_date: '2026-03-17', location_id: LOC_A } })],   // St Patrick's Day
      staff_lieu_credits: [],
    }
    expect((await runLieuCreditSweep(fakeDb(tables), { nowMs: NOW })).candidates).toBe(0)                // outside 14 days
    const stats = await runLieuCreditSweep(fakeDb(tables), { nowMs: NOW, lookbackDays: 120 })
    expect(stats.inserted).toBe(1)
    expect(fakeDb(tables).writes).toEqual([])
    expect(tables.staff_lieu_credits[0]).toMatchObject({ source: 'public_holiday_worked', holiday_name: "St Patrick's Day" })
  })
})

describe('getLieuBalance / readLieuLedgerForProfiles', () => {
  const ledger = [
    { id: '1', profile_id: 'p1', source: 'sunday_worked', credit_date: '2026-06-07', hours: '10.67' },
    { id: '2', profile_id: 'p1', source: 'taken', credit_date: '2026-07-01', hours: '-4' },
    { id: '3', profile_id: 'p1', source: 'manual', credit_date: '2025-12-31', hours: '3' },     // last year
    { id: '4', profile_id: 'p2', source: 'manual', credit_date: '2026-01-02', hours: '5' },     // someone else
  ]
  it("sums one person's year: credited, taken, balance", async () => {
    const { lieu, error } = await getLieuBalance(fakeDb({ staff_lieu_credits: ledger }), 'p1', 2026)
    expect(error).toBeNull()
    expect(lieu).toEqual({ year: 2026, credited_hours: 10.67, taken_hours: 4, balance_hours: 6.67 })
  })
  it('fails closed: an unreadable ledger is an error, never 0', async () => {
    const { lieu, error } = await getLieuBalance(fakeDb({ staff_lieu_credits: ledger }, { fail: 'staff_lieu_credits' }), 'p1', 2026)
    expect(lieu).toBeNull()
    expect(error.message).toMatch(/down/)
  })
  it('reads several people up to a date, with an optional lower bound', async () => {
    const { rows } = await readLieuLedgerForProfiles(fakeDb({ staff_lieu_credits: ledger }), ['p1', 'p2'], { to: '2026-06-30' })
    expect(rows.map((r) => r.id).sort()).toEqual(['1', '3', '4'])
    const bounded = await readLieuLedgerForProfiles(fakeDb({ staff_lieu_credits: ledger }), ['p1'], { from: '2026-01-01', to: '2026-12-31' })
    expect(bounded.rows.map((r) => r.id)).toEqual(['1', '2'])
  })
})
