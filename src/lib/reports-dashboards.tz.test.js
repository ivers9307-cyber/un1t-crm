// reports-dashboards.tz.test.js — TZ.11a. Dashboards, membership snapshots and
// flows, the labour month, Account Home and the Today feed's labels use the
// STUDIO's calendar; billing stays on the platform's (D5). Europe/Dublin is
// byte-identical to the frozen pre-TZ.11a copies; America/New_York is pinned
// across both 2026 DST changes.
process.env.TZ = 'America/Los_Angeles' // host zone is neither zone under test: nothing reads the host clock
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logInfo: vi.fn(), logError: vi.fn() }))

const L = await import('./tz-11a.legacy-dublin.test-helpers.js')
const DD = await import('@shared/dashboard-data')
const { writeMembershipSnapshot, fetchMembershipTrend } = await import('./membership-snapshot.js')
const { fetchMembershipFlows } = await import('./membership-flows.js')
const { labourMonthWindow } = await import('./labour-month-model.js')
const { studioWeekWindow, dublinWeekWindow, assembleAccountHome } = await import('./account-home.js')
const { lowFillTimeLabel } = await import('./today-feed-data.js')
const { walletResetMs, walletResetLocalLabel, walletResetNote } = await import('./wallet.js')
const { billingMonthWindow } = await import('./wallet-enforcement.js')
const { resetLocationZoneCache } = await import('./location-time.js')

const DUB = 'Europe/Dublin'
const NY = 'America/New_York'
const at = (iso) => Date.parse(iso)
// US DST 2026: spring forward Sun 8 Mar; fall back Sun 1 Nov.
// EU DST 2026: spring forward Sun 29 Mar 01:00Z; fall back Sun 25 Oct 01:00Z.
const SAMPLES = [
  '2026-03-07T04:30:00Z', '2026-03-08T06:59:00Z', '2026-03-08T07:00:00Z',
  '2026-03-28T23:30:00Z', '2026-03-29T00:59:00Z', '2026-03-29T01:00:00Z',
  '2026-10-24T23:30:00Z', '2026-10-25T00:59:00Z', '2026-10-25T01:00:00Z',
  '2026-11-01T04:59:00Z', '2026-11-01T05:00:00Z', '2026-11-01T06:00:00Z',
  '2026-06-30T22:59:00Z', '2026-06-30T23:00:00Z', '2026-12-31T23:30:00Z',
]
const EVERY_2026_HOUR = []
for (let ms = Date.UTC(2026, 0, 1); ms < Date.UTC(2027, 0, 1); ms += 3_600_000) EVERY_2026_HOUR.push(ms)

// A supabase stand-in that records every builder call and answers empty.
function recordingDb(rows = {}) {
  const log = []
  return {
    log,
    from(table) {
      const calls = []
      log.push({ table, calls })
      const b = new Proxy({}, {
        get(_t, prop) {
          if (prop === 'then') return (resolve) => resolve({ data: rows[table] || [], count: 0, error: null })
          return (...args) => { calls.push([prop, ...args]); return b }
        },
      })
      return b
    },
  }
}
const callsOf = (db) => db.log.map(({ table, calls }) => ({ table, calls }))
const argOf = (db, table, method, col) => db.log.filter((q) => q.table === table)
  .flatMap((q) => q.calls).find(([m, c]) => m === method && c === col)?.[2]

describe('TZ.11a shared/dashboard-data — Europe/Dublin byte-identical', () => {
  it.each(SAMPLES)('fetchRevenueMTD / fetchFunnelCounts at %s issue the same queries', async (iso) => {
    const now = new Date(iso)
    const a = recordingDb(); const b = recordingDb()
    expect(await DD.fetchRevenueMTD(a, 'loc', now, DUB)).toStrictEqual(await L.fetchRevenueMTDLegacy(b, 'loc', now))
    expect(callsOf(a)).toStrictEqual(callsOf(b))
    const c = recordingDb(); const d = recordingDb()
    expect(await DD.fetchFunnelCounts(c, 'loc', now, DUB)).toStrictEqual(await L.fetchFunnelCountsLegacy(d, 'loc', now))
    expect(callsOf(c)).toStrictEqual(callsOf(d))
  })
  it('fetchRevenueMTD with no zone is the Dublin call (backward-compatible signature)', async () => {
    const a = recordingDb(); const b = recordingDb()
    await DD.fetchRevenueMTD(a, 'loc', new Date(SAMPLES[3]))
    await L.fetchRevenueMTDLegacy(b, 'loc', new Date(SAMPLES[3]))
    expect(callsOf(a)).toStrictEqual(callsOf(b))
  })
  it('fetchTodayOps: the day, class window and labour week match at every hour of 2026', async () => {
    for (const ms of EVERY_2026_HOUR.filter((_, i) => i % 7 === 0).concat(SAMPLES.map(at))) {
      const db = recordingDb()
      await DD.fetchTodayOps(db, 'loc', new Date(ms), DUB)
      const w = L.todayOpsWindowLegacy(ms)
      expect(argOf(db, 'bookings', 'eq', 'booking_date')).toBe(w.todayIso)
      expect(argOf(db, 'class_occurrences', 'gte', 'starts_at')).toBe(new Date(w.dayStartMs).toISOString())
      expect(argOf(db, 'class_occurrences', 'lt', 'starts_at')).toBe(new Date(w.dayEndMs).toISOString())
      expect(argOf(db, 'shift_blocks', 'eq', 'block_date')).toBe(w.todayIso)
      expect(argOf(db, 'shift_assignments', 'gte', 'shift_blocks.block_date')).toBe(w.weekStartIso)
      expect(argOf(db, 'shift_assignments', 'lte', 'shift_blocks.block_date')).toBe(w.weekEndIso)
    }
  })
})

describe('TZ.11a shared/dashboard-data — America/New_York', () => {
  it('Revenue MTD: 1 Nov 03:30Z is still October in New York (from 1 Oct 00:00 EDT)', async () => {
    const db = recordingDb()
    await DD.fetchRevenueMTD(db, 'loc', new Date('2026-11-01T03:30:00Z'), NY)
    expect(argOf(db, 'glofox_invoices', 'gte', 'invoice_date')).toBe('2026-10-01T04:00:00.000Z')
    // last month = 1 Sep .. 31 Oct-clamped-to-30 Sep, i.e. [1 Sep 00:00 EDT, 1 Oct 00:00 EDT)
    const second = db.log.filter((q) => q.table === 'glofox_invoices')[1].calls
    expect(second).toContainEqual(['gte', 'invoice_date', '2026-09-01T04:00:00.000Z'])
    expect(second).toContainEqual(['lt', 'invoice_date', '2026-10-01T04:00:00.000Z'])
  })
  it('Funnel month starts 1 Nov 00:00 EDT (04:00Z), an hour before EST begins', async () => {
    const db = recordingDb()
    await DD.fetchFunnelCounts(db, 'loc', new Date('2026-11-15T12:00:00Z'), NY)
    expect(argOf(db, 'contacts', 'gte', 'joined_at')).toBe('2026-11-01T04:00:00.000Z')
  })
  it('Today ops on the fall-back Sunday: a 25-hour local day, the week from Mon 26 Oct', async () => {
    const db = recordingDb()
    await DD.fetchTodayOps(db, 'loc', new Date('2026-11-01T12:00:00Z'), NY)
    expect(argOf(db, 'bookings', 'eq', 'booking_date')).toBe('2026-11-01')
    expect(argOf(db, 'class_occurrences', 'gte', 'starts_at')).toBe('2026-11-01T04:00:00.000Z')
    expect(argOf(db, 'class_occurrences', 'lt', 'starts_at')).toBe('2026-11-02T05:00:00.000Z')
    expect(argOf(db, 'shift_assignments', 'gte', 'shift_blocks.block_date')).toBe('2026-10-26')
    expect(argOf(db, 'shift_assignments', 'lte', 'shift_blocks.block_date')).toBe('2026-11-01')
  })
  it('Today ops on the spring-forward Sunday: a 23-hour local day', async () => {
    const db = recordingDb()
    await DD.fetchTodayOps(db, 'loc', new Date('2026-03-08T15:00:00Z'), NY)
    expect(argOf(db, 'class_occurrences', 'gte', 'starts_at')).toBe('2026-03-08T05:00:00.000Z')
    expect(argOf(db, 'class_occurrences', 'lt', 'starts_at')).toBe('2026-03-09T04:00:00.000Z')
  })
})

describe('TZ.11a membership snapshot + trend', () => {
  function upsertDb() {
    const upserts = []
    const db = recordingDb()
    const from = db.from.bind(db)
    db.from = (table) => {
      const b = from(table)
      if (table !== 'membership_snapshots') return b
      return new Proxy(b, { get: (t, p) => (p === 'upsert' ? (row) => { upserts.push(row); return Promise.resolve({ error: null }) } : t[p]) })
    }
    return { db, upserts }
  }
  it.each(SAMPLES)('Europe/Dublin snapshot_date is byte-identical at %s', async (iso) => {
    const { db, upserts } = upsertDb()
    const out = await writeMembershipSnapshot(db, 'loc', { now: at(iso), zone: DUB })
    expect(out.snapshot_date).toBe(L.snapshotDateLegacy({ now: at(iso) }))
    expect(upserts[0].snapshot_date).toBe(L.snapshotDateLegacy({ now: at(iso) }))
  })
  it('no zone = the Dublin key (backward-compatible)', async () => {
    const { db } = upsertDb()
    expect((await writeMembershipSnapshot(db, 'loc', { now: at(SAMPLES[6]) })).snapshot_date).toBe(L.snapshotDateLegacy({ now: at(SAMPLES[6]) }))
  })
  it('America/New_York: the 02:00 UTC cron writes the local day that just ended', async () => {
    // Sun 1 Nov 02:00Z = Sat 31 Oct 22:00 EDT; Sun 8 Mar 02:00Z = Sat 7 Mar 21:00 EST.
    expect((await writeMembershipSnapshot(upsertDb().db, 'loc', { now: at('2026-11-01T02:00:00Z'), zone: NY })).snapshot_date).toBe('2026-10-31')
    expect((await writeMembershipSnapshot(upsertDb().db, 'loc', { now: at('2026-03-08T02:00:00Z'), zone: NY })).snapshot_date).toBe('2026-03-07')
    // Dublin at the same instant is already the next day.
    expect((await writeMembershipSnapshot(upsertDb().db, 'loc', { now: at('2026-11-01T02:00:00Z'), zone: DUB })).snapshot_date).toBe('2026-11-01')
  })
  it('trend window: N months before the LOCATION today', async () => {
    for (const iso of SAMPLES) {
      const db = recordingDb()
      await fetchMembershipTrend(db, 'loc', 12, { zone: DUB, nowMs: at(iso) })
      expect(argOf(db, 'membership_snapshots', 'gte', 'snapshot_date')).toBe(L.monthsAgoFirstLegacy(12, L.snapshotDateLegacy({ now: at(iso) })))
    }
    const db = recordingDb()
    await fetchMembershipTrend(db, 'loc', 12, { zone: NY, nowMs: at('2026-11-01T03:30:00Z') }) // 31 Oct in NY
    expect(argOf(db, 'membership_snapshots', 'gte', 'snapshot_date')).toBe('2025-10-01')
  })
})

describe('TZ.11a membership flows', () => {
  const rows = {
    glofox_invoices: [
      { contact_id: 'c1', invoice_date: '2026-11-01T03:30:00Z' }, // 31 Oct NY, 1 Nov Dublin
      { contact_id: 'c2', invoice_date: '2026-10-15T12:00:00Z' },
    ],
    membership_transitions: [{ occurred_at: '2026-10-01T02:00:00Z' }], // 30 Sep NY, 1 Oct Dublin
  }
  it.each(SAMPLES)('Europe/Dublin months are byte-identical at %s', async (iso) => {
    const out = await fetchMembershipFlows(recordingDb(rows), 'loc', 12, at(iso), { zone: DUB })
    // the frozen key functions, applied the way the legacy body applied them
    const keys = out.months.map((m) => m.month)
    expect(keys.at(-1)).toBe(L.flowsTodayLegacy(at(iso)).slice(0, 7))
    const sales = Object.fromEntries(keys.map((k) => [k, 0]))
    for (const r of rows.glofox_invoices) { const k = L.flowsMonthOfLegacy(r.invoice_date); if (k in sales) sales[k]++ }
    for (const m of out.months) if (m.sales !== null) expect(m.sales).toBe(sales[m.month])
  })
  it('America/New_York buckets by the New York month', async () => {
    const out = await fetchMembershipFlows(recordingDb(rows), 'loc', 12, at('2026-11-15T12:00:00Z'), { zone: NY })
    const by = Object.fromEntries(out.months.map((m) => [m.month, m]))
    expect(by['2026-10'].sales).toBe(2)
    expect(by['2026-11'].sales).toBe(0)
    expect(by['2026-09'].cancellations).toBe(1) // 30 Sep 22:00 EDT
    expect(by['2026-10'].cancellations).toBe(0)
    const dub = await fetchMembershipFlows(recordingDb(rows), 'loc', 12, at('2026-11-15T12:00:00Z'), { zone: DUB })
    const dby = Object.fromEntries(dub.months.map((m) => [m.month, m]))
    expect(dby['2026-10'].sales).toBe(1)
    expect(dby['2026-11'].sales).toBe(1)
    expect(dby['2026-10'].cancellations).toBe(1)
  })
})

describe('TZ.11a labour month', () => {
  it('Europe/Dublin is byte-identical at every hour of 2026', () => {
    for (const ms of EVERY_2026_HOUR) expect(labourMonthWindow(ms, DUB)).toStrictEqual(L.labourMonthWindowLegacy(ms))
  })
  it('America/New_York: November starts 1 Nov 00:00 EDT and ends 1 Dec 00:00 EST', () => {
    const w = labourMonthWindow(at('2026-11-01T04:30:00Z'), NY)
    expect(w.month).toBe('2026-11')
    expect(new Date(w.startMs).toISOString()).toBe('2026-11-01T04:00:00.000Z')
    expect(new Date(w.endMs).toISOString()).toBe('2026-12-01T05:00:00.000Z')
    expect(labourMonthWindow(at('2026-11-01T03:30:00Z'), NY).month).toBe('2026-10')
  })
})

describe('TZ.11a Account Home', () => {
  it('Europe/Dublin window is byte-identical', () => {
    for (const iso of SAMPLES) {
      expect(studioWeekWindow(at(iso), DUB)).toStrictEqual(L.dublinWeekWindowLegacy(at(iso)))
      expect(dublinWeekWindow(at(iso))).toStrictEqual(L.dublinWeekWindowLegacy(at(iso)))
    }
  })
  it('each studio counts its own 7 days and its own today', async () => {
    const db = recordingDb()
    const now = at('2026-11-01T03:30:00Z') // 31 Oct in New York, 1 Nov in Dublin
    const out = await assembleAccountHome(db, {
      organization: { id: 'o1', name: 'Org' },
      locations: [{ id: 'l-dub', name: 'A', timezone: DUB }, { id: 'l-ny', name: 'B', timezone: NY }],
      now,
    })
    const bookings = db.log.filter((q) => q.table === 'bookings').map((q) => q.calls)
    const window = (loc) => {
      const c = bookings.find((calls) => calls.some(([m, col, v]) => m === 'eq' && col === 'location_id' && v === loc))
      return [c.find(([m]) => m === 'gte')[2], c.find(([m]) => m === 'lte')[2]]
    }
    expect(window('l-dub')).toEqual(['2026-10-26', '2026-11-01'])
    expect(window('l-ny')).toEqual(['2026-10-25', '2026-10-31'])
    const leave = db.log.filter((q) => q.table === 'time_off_requests').map((q) => q.calls)
    const floor = (loc) => leave.find((calls) => calls.some(([m, col, v]) => m === 'eq' && col === 'location_id' && v === loc))
      .find(([m, col]) => m === 'gte' && col === 'end_date')[2]
    expect(floor('l-dub')).toBe(L.openApprovalsFloorLegacy(now))
    expect(floor('l-ny')).toBe('2026-10-31')
    expect(out.kpis.weekWindow).toEqual({ start: '2026-10-26', end: '2026-11-01' })
  })
})

describe('TZ.11a Today feed low-fill label', () => {
  it('Europe/Dublin is byte-identical; New York reads its own clock', () => {
    for (const iso of SAMPLES) expect(lowFillTimeLabel(at(iso), DUB)).toBe(L.lowFillTimeLabelLegacy(at(iso)))
    expect(lowFillTimeLabel(at('2026-11-01T13:00:00Z'), NY)).toBe('08:00') // EST
    expect(lowFillTimeLabel(at('2026-10-31T12:00:00Z'), NY)).toBe('08:00') // EDT
  })
})

describe('TZ.11a / D5 — billing stays on the platform calendar', () => {
  beforeEach(() => resetLocationZoneCache())
  it('the billing month window is Irish midnight whatever the tenant zone', () => {
    expect(billingMonthWindow('2026-10-15')).toEqual({
      monthStart: '2026-10-01', monthNext: '2026-11-01',
      startIso: '2026-09-30T23:00:00.000Z', endIso: '2026-11-01T00:00:00.000Z',
    })
  })
  it('the reset is 00:00 Irish time on the 1st; a non-Irish studio is told its own time', () => {
    expect(new Date(walletResetMs('2026-10-15')).toISOString()).toBe('2026-11-01T00:00:00.000Z') // GMT
    expect(new Date(walletResetMs('2026-03-15')).toISOString()).toBe('2026-03-31T23:00:00.000Z') // IST
    expect(walletResetLocalLabel('2026-10-15', NY)).toBe('31 Oct, 20:00') // EDT
    expect(walletResetLocalLabel('2026-03-15', NY)).toBe('31 Mar, 19:00') // EDT, Dublin already on IST
    expect(walletResetLocalLabel('2026-11-15', NY)).toBe('30 Nov, 19:00') // EST
    expect(walletResetNote('2026-10-15', NY)).toBe('Resets on the 1st at 00:00 Irish time (31 Oct, 20:00 your time).')
  })
  it('a Europe/Dublin studio (or no zone) sees nothing new', () => {
    expect(walletResetLocalLabel('2026-10-15', DUB)).toBeNull()
    expect(walletResetNote('2026-10-15', null)).toBeNull()
  })
})
