// FEES.1 — the class-fees run: detection, the 17:00 charge and its
// compare-and-set claims, the 7-day retry, outstanding, waive and the staff
// retry. A small in-memory PostgREST fake; the un1t.online charge is stubbed
// (its own tests are un1t-online-write.fee.test.js).
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))
vi.mock('./postmark.js', () => ({ sendTransactionalEmail: vi.fn(async () => ({ messageId: 'm1' })) }))
vi.mock('./app-url.js', () => ({ getAppUrl: () => 'https://crm.example.test' }))
vi.mock('./un1t-online-write-ops.js', () => ({ chargeClassFee: vi.fn() }))
vi.mock('./location-time.js', async (orig) => ({ ...(await orig()), getLocationZone: vi.fn(async () => 'Europe/Dublin') }))

import { chargeClassFee } from './un1t-online-write-ops.js'
import { sendTransactionalEmail } from './postmark.js'
import { detectClassFees, chargeDueClassFees, waiveClassFee, retryContactFees, sendReviewEmail, readClassFeeContext } from './class-fees-run.js'

const LOC = 'loc-1'
const SETTINGS = { un1t_online: { writes_enabled: true, fees: { enabled: true, late_cancel_fee_cents: 1000, no_show_fee_cents: 1500, review_emails: ['ops@hatch.test'] } } }

// ── a tiny PostgREST fake ──────────────────────────────────────────────────
function cmp(op, a, b) {
  if (op === 'eq') return String(a) === String(b)
  if (op === 'lte') return a != null && String(a) <= String(b)
  if (op === 'lt') return a != null && String(a) < String(b)
  if (op === 'gte') return a != null && String(a) >= String(b)
  return false
}
function parseOr(expr) {
  // and(a.eq.x,b.lte.y),and(...)
  return [...expr.matchAll(/and\(([^)]*)\)/g)].map((m) => m[1].split(',').map((part) => {
    const [col, op, ...rest] = part.split('.')
    return [op, col, rest.join('.')]
  }))
}
function makeDb(tables) {
  const store = Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.map((r) => ({ ...r }))]))
  let seq = 0
  const db = {
    store,
    from(name) {
      store[name] ??= []
      const s = { op: 'select', filters: [], ors: null, payload: null, opts: null, head: false, single: false }
      const rows = () => store[name]
      const match = (r) => s.filters.every(([op, c, v]) => (op === 'in' ? v.includes(r[c]) : op === 'is' ? r[c] === v : cmp(op, r[c], v)))
        && (!s.ors || s.ors.some((group) => group.every(([op, c, v]) => cmp(op, r[c], v))))
      const run = () => {
        if (s.op === 'upsert' || s.op === 'insert') {
          const out = []
          for (const p of [].concat(s.payload)) {
            const dupe = rows().find((r) => r.location_id === p.location_id && r.un1t_booking_id === p.un1t_booking_id)
            if (dupe && s.opts?.ignoreDuplicates) continue
            const row = { id: `id-${++seq}`, attempts: 0, ...p }
            rows().push(row)
            out.push({ ...row })
          }
          return { data: out, error: null }
        }
        if (s.op === 'update') {
          const hit = rows().filter(match)
          for (const r of hit) Object.assign(r, s.payload)
          return { data: hit.map((r) => ({ ...r })), error: null }
        }
        const hit = rows().filter(match).map((r) => ({ ...r }))
        if (s.head) return { data: null, count: hit.length, error: null }
        if (s.single) return { data: hit[0] ?? null, error: null }
        return { data: hit, error: null }
      }
      const api = {
        select(_c, o) { if (s.op === 'select' && o?.head) s.head = true; return api },
        insert(p) { s.op = 'insert'; s.payload = p; return api },
        upsert(p, o) { s.op = 'upsert'; s.payload = p; s.opts = o; return api },
        update(p) { s.op = 'update'; s.payload = p; return api },
        eq(c, v) { s.filters.push(['eq', c, v]); return api },
        in(c, v) { s.filters.push(['in', c, v]); return api },
        is(c, v) { s.filters.push(['is', c, v]); return api },
        gte(c, v) { s.filters.push(['gte', c, v]); return api },
        lte(c, v) { s.filters.push(['lte', c, v]); return api },
        lt(c, v) { s.filters.push(['lt', c, v]); return api },
        or(e) { s.ors = parseOr(e); return api },
        order() { return api },
        limit() { return api },
        range(from) { if (from > 0) { s.filters.push(['in', 'id', []]) } return api },
        maybeSingle() { s.single = true; return api },
        then(res, rej) { return Promise.resolve(run()).then(res, rej) },
      }
      return api
    },
  }
  return db
}

const writerFactory = (windowHours = 2) => vi.fn(async () => ({
  locationId: LOC, studioId: 'studio-1',
  read: vi.fn(async () => ({ default_cancelation_window_hours: windowHours })),
}))

const baseTables = (over = {}) => ({
  locations: [{ id: LOC, name: 'Hatch', organization_id: 'org-1', membership_source: 'un1t_online', settings: SETTINGS }],
  un1t_events: [
    { location_id: LOC, un1t_id: 'e1', title: 'Strength', status: 'completed', starts_at: '2026-10-28T18:30:00.000Z' },
    { location_id: LOC, un1t_id: 'e2', title: 'Mobility', status: 'cancelled', starts_at: '2026-10-28T19:30:00.000Z' },
  ],
  un1t_bookings: [
    { location_id: LOC, un1t_id: 'b-noshow', un1t_user_id: 'u1', contact_id: 'c1', event_id: 'e1', status: 'no_show', credit_charged: false },
    { location_id: LOC, un1t_id: 'b-late', un1t_user_id: 'u2', contact_id: 'c2', event_id: 'e1', status: 'cancelled', credit_charged: false, cancelled_at: '2026-10-28T17:45:00.000Z' },
    { location_id: LOC, un1t_id: 'b-early', un1t_user_id: 'u3', contact_id: 'c3', event_id: 'e1', status: 'cancelled', credit_charged: false, cancelled_at: '2026-10-28T09:00:00.000Z' },
    { location_id: LOC, un1t_id: 'b-staff', un1t_user_id: 'u4', contact_id: 'c4', event_id: 'e1', status: 'cancelled', credit_charged: false, cancelled_at: '2026-10-28T18:00:00.000Z' },
    { location_id: LOC, un1t_id: 'b-pack', un1t_user_id: 'u5', contact_id: 'c5', event_id: 'e1', status: 'no_show', credit_charged: true },
    { location_id: LOC, un1t_id: 'b-undecided', un1t_user_id: 'u6', contact_id: 'c6', event_id: 'e1', status: 'booked', credit_charged: false },
    { location_id: LOC, un1t_id: 'b-classoff', un1t_user_id: 'u7', contact_id: 'c7', event_id: 'e2', status: 'no_show', credit_charged: false },
  ],
  un1t_clients: [
    { location_id: LOC, un1t_user_id: 'u1', credit_unlimited: true },
    { location_id: LOC, un1t_user_id: 'u2', credit_unlimited: true },
    { location_id: LOC, un1t_user_id: 'u5', credit_unlimited: false },
  ],
  un1t_write_events: [{ location_id: LOC, op: 'cancel', stage: 'done', origin: 'staff', target: 'b-staff' }],
  contacts: [{ id: 'c1', first_name: 'Ann', last_name: 'A' }, { id: 'c2', first_name: 'Bob', last_name: 'B' }],
  class_fees: [],
  ...over,
})

const NIGHT = Date.parse('2026-10-28T23:05:00Z')
const fees = (db) => db.store.class_fees

beforeEach(() => vi.clearAllMocks())

describe('detectClassFees', () => {
  it('finds the no-show and the late cancel as fees, records the pack forfeit, and skips the rest', async () => {
    const db = makeDb(baseTables())
    const out = await detectClassFees(db, { locationId: LOC, nowMs: NIGHT }, { writerFactory: writerFactory(2) })
    expect(out.inserted).toBe(3)
    expect(out.undecided.map((u) => u.bookingId)).toEqual(['b-undecided'])
    const byBooking = Object.fromEntries(fees(db).map((f) => [f.un1t_booking_id, f]))
    expect(Object.keys(byBooking).sort()).toEqual(['b-late', 'b-noshow', 'b-pack'])
    expect(byBooking['b-noshow']).toMatchObject({ status: 'pending', amount_cents: 1500, kind: 'no_show', charge_due_at: '2026-10-29T17:00:00.000Z' })
    expect(byBooking['b-late']).toMatchObject({ status: 'pending', amount_cents: 1000, kind: 'late_cancel', minutes_before_start: 45 })
    expect(byBooking['b-late'].charge_description).toBe('Late cancellation: Strength, Wed 28 Oct 2026, 18:30')
    expect(byBooking['b-pack']).toMatchObject({ status: 'recorded', penalty: 'credit_forfeit', amount_cents: 0 })
  })

  it('a re-run inserts nothing new and never touches a fee already on file', async () => {
    const db = makeDb(baseTables())
    await detectClassFees(db, { locationId: LOC, nowMs: NIGHT }, { writerFactory: writerFactory(2) })
    fees(db).find((f) => f.un1t_booking_id === 'b-noshow').status = 'waived'
    const again = await detectClassFees(db, { locationId: LOC, nowMs: NIGHT }, { writerFactory: writerFactory(2) })
    expect(again.inserted).toBe(0)
    expect(fees(db).find((f) => f.un1t_booking_id === 'b-noshow').status).toBe('waived')
  })

  it('with no readable un1t.online window, no cancel is called late', async () => {
    const db = makeDb(baseTables())
    await detectClassFees(db, { locationId: LOC, nowMs: NIGHT }, { writerFactory: writerFactory(null) })
    expect(fees(db).map((f) => f.un1t_booking_id).sort()).toEqual(['b-noshow', 'b-pack'])
  })
})

describe('the review email', () => {
  it('goes to each recipient with the due fees, the counts and the review link', async () => {
    const db = makeDb(baseTables())
    await detectClassFees(db, { locationId: LOC, nowMs: NIGHT }, { writerFactory: writerFactory(2) })
    const ctx = await readClassFeeContext(db, LOC)
    const out = await sendReviewEmail(db, { locationId: LOC, location: ctx.location, settings: ctx.settings, zone: ctx.zone, nowMs: NIGHT, undecidedCount: 1 })
    expect(out.sent).toBe(true)
    const mail = sendTransactionalEmail.mock.calls[0][0]
    expect(mail).toMatchObject({ to: 'ops@hatch.test', locationId: LOC, tag: 'class-fees-review' })
    expect(mail.contactId).toBeUndefined()
    expect(mail.subject).toBe('Class fees for Wed 28 Oct: 2 to charge at 17:00 tomorrow')
    expect(mail.htmlBody).toContain('https://crm.example.test/class-fees')
    expect(mail.htmlBody).toContain('Ann A')
    expect(mail.htmlBody).toContain('€25.00')
    expect(mail.htmlBody).toContain('1 booking(s) are still marked booked')
  })
})

describe('chargeDueClassFees', () => {
  const ctxOf = async (db) => readClassFeeContext(db, LOC)
  const DUE = Date.parse('2026-10-29T17:05:00Z')

  async function seeded() {
    const db = makeDb(baseTables())
    await detectClassFees(db, { locationId: LOC, nowMs: NIGHT }, { writerFactory: writerFactory(2) })
    return db
  }

  it('nothing is charged before it is due', async () => {
    const db = await seeded()
    const ctx = await ctxOf(db)
    const out = await chargeDueClassFees(db, { locationId: LOC, nowMs: Date.parse('2026-10-29T16:05:00Z'), settings: ctx.settings, zone: ctx.zone })
    expect(out.attempted).toBe(0)
    expect(chargeClassFee).not.toHaveBeenCalled()
  })

  it('charges each due fee once with attempt 1; a credit forfeit is never charged', async () => {
    const db = await seeded()
    const ctx = await ctxOf(db)
    chargeClassFee.mockImplementation(async (_db, a) => ({ verdict: 'done', id: `tx-${a.feeId}` }))
    const out = await chargeDueClassFees(db, { locationId: LOC, nowMs: DUE, settings: ctx.settings, zone: ctx.zone })
    expect(out).toMatchObject({ attempted: 2, charged: 2 })
    expect(chargeClassFee.mock.calls.map(([, a]) => [a.attempt, a.origin, a.resume])).toEqual([[1, 'fee_run', false], [1, 'fee_run', false]])
    expect(fees(db).filter((f) => f.status === 'charged')).toHaveLength(2)
    expect(fees(db).find((f) => f.penalty === 'credit_forfeit').status).toBe('recorded')
    // A second run finds nothing to do.
    const again = await chargeDueClassFees(db, { locationId: LOC, nowMs: DUE, settings: ctx.settings, zone: ctx.zone })
    expect(again.attempted).toBe(0)
  })

  it('refused → retry in 7 days with attempt 2 → refused again → outstanding; staff retry then charges it', async () => {
    const db = await seeded()
    const ctx = await ctxOf(db)
    chargeClassFee.mockResolvedValue({ verdict: 'refused', code: 'card_declined', message: 'Your card was declined.', retryable: false })
    await chargeDueClassFees(db, { locationId: LOC, nowMs: DUE, settings: ctx.settings, zone: ctx.zone })
    const f = fees(db).find((x) => x.un1t_booking_id === 'b-noshow')
    expect(f).toMatchObject({ status: 'retry_scheduled', attempts: 1, next_attempt_at: '2026-11-05T17:00:00.000Z', failure_message: 'Your card was declined.' })

    await chargeDueClassFees(db, { locationId: LOC, nowMs: Date.parse('2026-11-05T17:05:00Z'), settings: ctx.settings, zone: ctx.zone })
    expect(chargeClassFee.mock.calls.at(-1)[1].attempt).toBe(2)
    expect(fees(db).find((x) => x.un1t_booking_id === 'b-noshow')).toMatchObject({ status: 'outstanding', attempts: 2 })

    chargeClassFee.mockResolvedValue({ verdict: 'done', id: 'tx-late' })
    const r = await retryContactFees(db, { locationId: LOC, contactId: 'c1', actor: { id: 'staff-1' } })
    expect(r.outcomes).toEqual([expect.objectContaining({ status: 'charged' })])
    expect(chargeClassFee.mock.calls.at(-1)[1]).toMatchObject({ attempt: 3, origin: 'staff', actor: { id: 'staff-1' } })
  })

  it('a refusal that sent nothing hands the attempt back and stays pending', async () => {
    const db = await seeded()
    const ctx = await ctxOf(db)
    chargeClassFee.mockResolvedValue({ verdict: 'refused', code: 'UN1T_RATE_BUDGET', retryable: true })
    await chargeDueClassFees(db, { locationId: LOC, nowMs: DUE, settings: ctx.settings, zone: ctx.zone })
    for (const f of fees(db).filter((x) => x.penalty === 'fee')) expect(f).toMatchObject({ status: 'pending', attempts: 0 })
  })

  it('unknown stays charging; after 15 minutes the run resumes the same attempt', async () => {
    const db = await seeded()
    const ctx = await ctxOf(db)
    chargeClassFee.mockResolvedValue({ verdict: 'unknown' })
    await chargeDueClassFees(db, { locationId: LOC, nowMs: DUE, settings: ctx.settings, zone: ctx.zone })
    expect(fees(db).filter((x) => x.status === 'charging')).toHaveLength(2)
    // Ten minutes later: still in flight, left alone.
    const early = await chargeDueClassFees(db, { locationId: LOC, nowMs: DUE + 10 * 60_000, settings: ctx.settings, zone: ctx.zone })
    expect(early.attempted).toBe(0)
    chargeClassFee.mockResolvedValue({ verdict: 'done', id: 'tx-r' })
    const later = await chargeDueClassFees(db, { locationId: LOC, nowMs: DUE + 60 * 60_000, settings: ctx.settings, zone: ctx.zone })
    expect(later.charged).toBe(2)
    expect(chargeClassFee.mock.calls.at(-1)[1]).toMatchObject({ attempt: 1, resume: true })
  })
})

describe('waiveClassFee', () => {
  it('waives a pending fee; a charged one or another studio is refused', async () => {
    const db = makeDb(baseTables({ class_fees: [
      { id: 'f1', location_id: LOC, status: 'pending' },
      { id: 'f2', location_id: LOC, status: 'charged' },
      { id: 'f3', location_id: 'other', status: 'pending' },
    ] }))
    expect(await waiveClassFee(db, { locationId: LOC, feeId: 'f1', actorId: 'u', reason: 'injured' })).toEqual({ ok: true, status: 'waived' })
    expect(fees(db)[0]).toMatchObject({ status: 'waived', waived_by: 'u', waived_reason: 'injured' })
    expect(await waiveClassFee(db, { locationId: LOC, feeId: 'f2', actorId: 'u', reason: 'x' })).toMatchObject({ ok: false, reason: 'not_waivable' })
    expect(await waiveClassFee(db, { locationId: LOC, feeId: 'f3', actorId: 'u', reason: 'x' })).toEqual({ ok: false, reason: 'not_found' })
  })

  it('a waive that loses the race to the 17:00 claim changes nothing', async () => {
    const db = makeDb(baseTables({ class_fees: [{ id: 'f1', location_id: LOC, status: 'pending' }] }))
    const realFrom = db.from.bind(db)
    // The claim lands between the waive's read and its write.
    db.from = (name) => {
      const q = realFrom(name)
      const update = q.update
      q.update = (p) => { db.store.class_fees[0].status = 'charging'; return update(p) }
      return q
    }
    expect(await waiveClassFee(db, { locationId: LOC, feeId: 'f1', actorId: 'u', reason: 'x' })).toMatchObject({ ok: false, reason: 'not_waivable' })
    expect(db.store.class_fees[0].status).toBe('charging')
  })
})
