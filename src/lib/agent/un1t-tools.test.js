// MIAHATCH.2 — the four member reads at a un1t.online studio.
// Fictional ids only (the repo is public). Nothing here talks to un1t.online:
// the live read is the Task 4 function, mocked at its result shape.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))
vi.mock('./un1t-member-read', () => ({ fetchLiveUn1tBookings: vi.fn() }))
// MIAHATCH.3 — the payment reminder reads the Spec A seam; the adapter is mocked.
vi.mock('@/lib/membership/reads', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, membershipReadsFor: vi.fn() }
})
vi.mock('@/lib/membership/source', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, providerFor: vi.fn(actual.providerFor) }
})
// The Glofox executors stay real; the spies let a test see how the dual-studio
// section called them.
vi.mock('./account-tools', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, executeAccountTool: vi.fn(actual.executeAccountTool) }
})
vi.mock('./booking-tools', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, executeBookingTool: vi.fn(actual.executeBookingTool) }
})

import {
  UN1T_BOOKED_STATUS,
  UN1T_EVENT_SCHEDULED_STATUS,
  UN1T_PRODUCT_ACTIVE_STATUS,
  UN1T_PRODUCT_PRIVATE_VISIBILITY,
  UN1T_NO_7_DAY_NOTE,
  shapeUn1tMembership,
  shapeUn1tBookingsForAgent,
  shapeUn1tAttendance,
  shapeUn1tTimetableForAgent,
  un1tPriceLabel,
  executeUn1tRead,
  executeUn1tTimetable,
} from './un1t-tools'
import { executeAccountTool } from './account-tools'
import { executeBookingTool, UN1T_TIMETABLE_LIMIT, noBookingSystemAnswer } from './booking-tools'
import { TOOL_NOT_AT_THIS_STUDIO } from './tool-capability'
import { fetchLiveUn1tBookings } from './un1t-member-read'
import { providerFor } from '@/lib/membership/source'
import { membershipReadsFor } from '@/lib/membership/reads'
import { formatClassTime } from './dublin-format'
import { logWarn } from '@/lib/log'
import { resetLocationZoneCache } from '@/lib/location-time'

const NOW = Date.parse('2026-10-18T12:00:00Z')
const HATCH = 'a0000000-0000-0000-0000-0000000000b1'
const STILL = 'a0000000-0000-0000-0000-0000000000a1'
const USER = 'user-test-1'

const hatchStudio = { locationId: HATCH, name: 'Test Studio Hatch', providerKey: 'un1t_online', active: true, answerable: true, contactIds: ['c-h'], un1tUserId: USER }
const stillStudio = { locationId: STILL, name: 'Test Studio Still', providerKey: 'glofox', active: true, answerable: true, contactIds: ['c-s'], glofoxMemberId: 'gf-1' }

const iso = (ms) => new Date(ms).toISOString()
const DAY = 86_400_000

// ── a tiny chainable supabase double: filters really filter ──────────
function fakeDb(tables = {}, { errors = {} } = {}) {
  const calls = []
  const from = (table) => {
    const filters = []
    const call = { table, cols: null, eqs: {} }
    calls.push(call)
    const run = () => {
      if (errors[table]) return { data: null, error: { code: 'XX000', message: 'boom' } }
      return { data: filters.reduce((rows, f) => rows.filter(f), tables[table] ?? []), error: null }
    }
    const b = {
      select(cols) { call.cols = cols; return b },
      eq(col, val) { call.eqs[col] = val; filters.push((r) => r[col] === val); return b },
      in(col, vals) { filters.push((r) => vals.includes(r[col])); return b },
      gte(col, val) { filters.push((r) => Date.parse(r[col]) >= Date.parse(val)); return b },
      lte(col, val) { filters.push((r) => Date.parse(r[col]) <= Date.parse(val)); return b },
      order() { return b },
      limit(n) { call.limit = n; filters.push(((seen) => () => seen++ < n)(0)); return b },
      range(from_, to) { call.range = [from_, to]; const base = run(); return Promise.resolve(base.error ? base : { data: base.data.slice(from_, to + 1), error: null }) },
      async maybeSingle() { const r = run(); return r.error ? r : { data: r.data[0] ?? null, error: null } },
      then(resolve, reject) { return Promise.resolve(run()).then(resolve, reject) },
    }
    return b
  }
  return { from, calls }
}

const sub = (over = {}) => ({
  status: 'active', product_id: 'p-1', product_title: 'Monthly Foundation', price_cents: 18900, currency: 'eur',
  billing_interval: 'month', billing_interval_count: 1, current_period_end: '2026-11-20T00:00:00Z',
  cancel_at_period_end: false, paused_at: null, paused_until: null, past_due_at: null, ...over,
})

const ctxFor = (db, over = {}) => ({
  db, verifiedContactId: 'c-h', locationId: HATCH, zone: 'Europe/Dublin',
  turn: { block: 'un1t_read', answerable: [hatchStudio], channel: 'whatsapp', un1tWrites: false },
  ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  resetLocationZoneCache()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  fetchLiveUn1tBookings.mockResolvedValue({ ok: true, rows: [] })
})
afterEach(() => { vi.useRealTimers() })

describe('live values (17-18 Oct 2026)', () => {
  it('exports the constants the later tasks read', () => {
    expect(UN1T_BOOKED_STATUS).toBe('booked')
    expect(UN1T_PRODUCT_ACTIVE_STATUS).toBe('active')
    expect(UN1T_PRODUCT_PRIVATE_VISIBILITY).toBe('private')
  })
})

describe('un1tPriceLabel', () => {
  it('writes euros, whole or to the cent, with the billing interval', () => {
    expect(un1tPriceLabel({ price_cents: 12500 })).toBe('€125')
    expect(un1tPriceLabel({ price_cents: 18900, billing_interval: 'month', billing_interval_count: 1 })).toBe('€189 a month')
    expect(un1tPriceLabel({ price_cents: 1250 })).toBe('€12.50')
    expect(un1tPriceLabel({ price_cents: 50000, billing_interval: 'month', billing_interval_count: 3 })).toBe('€500 every 3 months')
    expect(un1tPriceLabel({ price_cents: 0 })).toBe('€0')
    expect(un1tPriceLabel({ price_cents: 9900, billing_interval: 'fortnight' })).toBe('€99')
  })
  it('is null with no price and never writes a dash', () => {
    expect(un1tPriceLabel({ price_cents: null })).toBeNull()
    expect(un1tPriceLabel({})).toBeNull()
    expect(un1tPriceLabel({ price_cents: 9900, currency: 'gbp' })).toBe('GBP 99')
  })
})

describe('shapeUn1tMembership', () => {
  const base = { creditsCapable: false, zone: 'Europe/Dublin', nowMs: NOW }
  it('active: plan, price and the renewal date', () => {
    expect(shapeUn1tMembership({ ...base, subscriptions: [sub()] })).toEqual({
      status: 'active', plan: 'Monthly Foundation', price_label: '€189 a month', renews_on: 'Fri 20 Nov 2026', credits: null,
    })
  })
  it('uses the live subscription with the latest current_period_end; ignores ended ones', () => {
    const out = shapeUn1tMembership({
      ...base,
      subscriptions: [
        sub({ product_title: 'Old', current_period_end: '2026-10-25T00:00:00Z' }),
        sub({ product_title: 'Newest', current_period_end: '2026-12-25T00:00:00Z' }),
        sub({ product_title: 'Cancelled later', status: 'canceled', current_period_end: '2027-06-01T00:00:00Z' }),
      ],
    })
    expect(out.plan).toBe('Newest')
    expect(out.renews_on).toBe('Fri 25 Dec 2026')
  })
  it('paused until a future date; a past paused_until is not paused', () => {
    const paused = shapeUn1tMembership({ ...base, subscriptions: [sub({ paused_at: '2026-10-10T00:00:00Z', paused_until: '2026-11-01T00:00:00Z' })] })
    expect(paused).toMatchObject({ status: 'paused', paused_until: 'Sun 1 Nov 2026', renews_on: null })
    expect(shapeUn1tMembership({ ...base, subscriptions: [sub({ paused_until: '2026-10-01T00:00:00Z' })] }).status).toBe('active')
  })
  it('an open-ended pause (paused_at past, no paused_until) is paused, with no renewal date', () => {
    const out = shapeUn1tMembership({ ...base, subscriptions: [sub({ paused_at: '2026-10-10T00:00:00Z', paused_until: null })] })
    expect(out).toMatchObject({ status: 'paused', paused_until: null, renews_on: null })
    // a pause that ended (both in the past) is active again; a pause not yet begun is not a pause
    expect(shapeUn1tMembership({ ...base, subscriptions: [sub({ paused_at: '2026-10-01T00:00:00Z', paused_until: '2026-10-05T00:00:00Z' })] }).status).toBe('active')
    expect(shapeUn1tMembership({ ...base, subscriptions: [sub({ paused_at: '2030-01-01T00:00:00Z', paused_until: null })] }).status).toBe('active')
  })
  it('ending on the period end when cancel_at_period_end, with no renewal date', () => {
    expect(shapeUn1tMembership({ ...base, subscriptions: [sub({ cancel_at_period_end: true })] }))
      .toMatchObject({ status: 'ending', ends_on: 'Fri 20 Nov 2026', renews_on: null })
  })
  it('payment issue when past_due_at is set, or the subscription itself is past_due', () => {
    expect(shapeUn1tMembership({ ...base, subscriptions: [sub({ past_due_at: '2026-10-15T00:00:00Z' })] }))
      .toMatchObject({ status: 'payment_issue', renews_on: null })
    expect(shapeUn1tMembership({ ...base, subscriptions: [sub({ status: 'past_due' })] }).status).toBe('payment_issue')
  })
  it('none: no live subscription', () => {
    expect(shapeUn1tMembership({ ...base, subscriptions: [] })).toEqual({ status: 'none', plan: null, price_label: null, renews_on: null, credits: null })
    expect(shapeUn1tMembership({ ...base, subscriptions: [sub({ status: 'canceled' })] }).status).toBe('none')
    expect(shapeUn1tMembership({ ...base })).toMatchObject({ status: 'none' })
  })
  it('credits: a number, unlimited (even at a zero balance), and null when creditsCapable is false', () => {
    const client = { credit_balance: 7, credit_unlimited: false }
    expect(shapeUn1tMembership({ ...base, subscriptions: [sub()], client, creditsCapable: true }).credits).toBe(7)
    expect(shapeUn1tMembership({ ...base, subscriptions: [sub()], client: { credit_balance: 0, credit_unlimited: true }, creditsCapable: true }).credits).toBe('unlimited')
    expect(shapeUn1tMembership({ ...base, subscriptions: [sub()], client, creditsCapable: false }).credits).toBeNull()
    expect(shapeUn1tMembership({ ...base, subscriptions: [sub()], client: { credit_balance: 0, credit_unlimited: false }, creditsCapable: true }).credits).toBe(0)
    expect(shapeUn1tMembership({ ...base, subscriptions: [sub()], client: null, creditsCapable: true }).credits).toBeNull()
    expect(shapeUn1tMembership({ ...base, subscriptions: [sub()], client: { credit_balance: null, credit_unlimited: null }, creditsCapable: true }).credits).toBeNull()
  })
  it('a credit pack holder with no subscription still reports credits', () => {
    expect(shapeUn1tMembership({ ...base, subscriptions: [], client: { credit_balance: 4 }, creditsCapable: true }))
      .toMatchObject({ status: 'none', credits: 4 })
  })
  it('falls back to the product for a missing title or price (Map or object)', () => {
    const bare = sub({ product_title: null, price_cents: null, billing_interval: null, billing_interval_count: null })
    const product = { title: 'From Product', price_cents: 9900, currency: 'eur', billing_interval: 'month', billing_interval_count: 1 }
    for (const productsById of [new Map([['p-1', product]]), { 'p-1': product }]) {
      expect(shapeUn1tMembership({ ...base, subscriptions: [bare], productsById })).toMatchObject({ plan: 'From Product', price_label: '€99 a month' })
    }
  })
})

describe('shapeUn1tBookingsForAgent', () => {
  const events = {
    e1: { title: 'HYROX', starts_at: iso(NOW + DAY) },
    e2: { title: 'Strength', starts_at: iso(NOW + 2 * DAY) },
    past: { title: 'Gone', starts_at: iso(NOW - DAY) },
  }
  it('future booked rows only, ids tagged un1t:, soonest first, label in the zone', () => {
    const rows = [
      { un1t_id: 'b2', event_id: 'e2', status: 'booked' },
      { un1t_id: 'b1', event_id: 'e1', status: 'booked' },
      { un1t_id: 'b3', event_id: 'e1', status: 'cancelled' },
      { un1t_id: 'b4', event_id: 'e1', status: 'attended' },
      { un1t_id: 'b5', event_id: 'e1', status: 'no_show' },
      { un1t_id: 'b6', event_id: 'past', status: 'booked' },
      { un1t_id: 'b7', event_id: 'unknown-event', status: 'booked' },
    ]
    const out = shapeUn1tBookingsForAgent(rows, events, NOW, 'Europe/Dublin')
    expect(out).toEqual([
      { booking_id: 'un1t:b1', class_name: 'HYROX', starts_at: formatClassTime(Math.floor((NOW + DAY) / 1000), 'Europe/Dublin') },
      { booking_id: 'un1t:b2', class_name: 'Strength', starts_at: formatClassTime(Math.floor((NOW + 2 * DAY) / 1000), 'Europe/Dublin') },
    ])
  })
  it('reads live API rows (id) as well as mirror rows (un1t_id); status is case-insensitive', () => {
    expect(shapeUn1tBookingsForAgent([{ id: 'b1', event_id: 'e1', status: 'BOOKED' }], events, NOW)).toHaveLength(1)
    expect(shapeUn1tBookingsForAgent([{ id: 'b1', event: { id: 'e1' }, status: 'booked' }], events, NOW)).toHaveLength(1)
  })
  it('at most 10, no duplicate booking ids', () => {
    const many = {}
    const rows = []
    for (let i = 0; i < 14; i++) {
      many[`e${i}`] = { title: `Class ${i}`, starts_at: iso(NOW + (i + 1) * 3_600_000) }
      rows.push({ un1t_id: `b${i}`, event_id: `e${i}`, status: 'booked' })
    }
    rows.push({ un1t_id: 'b0', event_id: 'e0', status: 'booked' })
    const out = shapeUn1tBookingsForAgent(rows, many, NOW)
    expect(out).toHaveLength(10)
    expect(out.map((b) => b.booking_id)).toEqual(Array.from({ length: 10 }, (_, i) => `un1t:b${i}`))
  })
  it('a blank title reads as Class; junk input is empty', () => {
    expect(shapeUn1tBookingsForAgent([{ un1t_id: 'b1', event_id: 'x', status: 'booked' }], { x: { title: '  ', starts_at: iso(NOW + DAY) } }, NOW)[0].class_name).toBe('Class')
    expect(shapeUn1tBookingsForAgent(null, {}, NOW)).toEqual([])
    expect(shapeUn1tBookingsForAgent([null, 'x'], {}, NOW)).toEqual([])
  })
})

describe('shapeUn1tAttendance', () => {
  it('says total_attended_7d is null with the exact note, and has no no-show field', () => {
    const out = shapeUn1tAttendance({ bookings_30d_attended: 9, bookings_30d_no_show: 3, last_attended_at: '2026-10-16T18:00:00Z' }, 'Europe/Dublin')
    expect(out).toEqual({
      found: true, total_attended_30d: 9, last_attended_on: 'Fri 16 Oct 2026', total_attended_7d: null,
      note: 'no 7-day count at this studio; never state one',
    })
    expect(UN1T_NO_7_DAY_NOTE).toBe('no 7-day count at this studio; never state one')
    expect(JSON.stringify(out)).not.toMatch(/no_show|no-show/)
  })
  it('no client row is found:false, still never a 7-day number', () => {
    expect(shapeUn1tAttendance(null)).toEqual({ found: false, total_attended_7d: null, note: UN1T_NO_7_DAY_NOTE })
    // A missing counter is unknown (null), never zero; a real zero stays zero.
    expect(shapeUn1tAttendance({ bookings_30d_attended: null, last_attended_at: null })).toMatchObject({ found: true, total_attended_30d: null, last_attended_on: null, note: UN1T_NO_7_DAY_NOTE })
    expect(shapeUn1tAttendance({ last_attended_at: null }).total_attended_30d).toBeNull()
    expect(shapeUn1tAttendance({ bookings_30d_attended: 0, last_attended_at: null }).total_attended_30d).toBe(0)
  })
})

// ── the executor ─────────────────────────────────────────────────────

const tables = () => ({
  un1t_subscriptions: [
    { location_id: HATCH, un1t_user_id: USER, un1t_id: 's1', ...sub() },
    { location_id: HATCH, un1t_user_id: 'someone-else', un1t_id: 's2', ...sub({ product_title: 'Not mine' }) },
    { location_id: STILL, un1t_user_id: USER, un1t_id: 's3', ...sub({ product_title: 'Other studio' }) },
  ],
  un1t_products: [{ location_id: HATCH, un1t_id: 'p-1', title: 'Monthly Foundation', price_cents: 18900, currency: 'eur', billing_interval: 'month', billing_interval_count: 1 }],
  un1t_clients: [
    { location_id: HATCH, un1t_user_id: USER, credit_balance: 5, credit_unlimited: false, last_attended_at: '2026-10-16T18:00:00Z', bookings_30d_attended: 8, bookings_30d_no_show: 2 },
    { location_id: HATCH, un1t_user_id: 'someone-else', credit_balance: 99, credit_unlimited: true, last_attended_at: null, bookings_30d_attended: 50, bookings_30d_no_show: 0 },
  ],
  un1t_events: [
    { location_id: HATCH, un1t_id: 'e1', title: 'HYROX', starts_at: iso(NOW + DAY), status: 'scheduled', capacity: 12, bookings_count: 12 },
    { location_id: HATCH, un1t_id: 'e2', title: 'Strength', starts_at: iso(NOW + 2 * DAY), status: 'scheduled', capacity: 12, bookings_count: 3 },
    { location_id: HATCH, un1t_id: 'e3', title: 'Mobility', starts_at: iso(NOW + 3 * DAY), status: 'scheduled', capacity: 12, bookings_count: 3 },
    { location_id: HATCH, un1t_id: 'e-past', title: 'Gone', starts_at: iso(NOW - DAY), status: 'scheduled', capacity: 12, bookings_count: 3 },
  ],
  un1t_bookings: [
    { location_id: HATCH, un1t_user_id: USER, un1t_id: 'b1', event_id: 'e1', status: 'booked' },
    { location_id: HATCH, un1t_user_id: USER, un1t_id: 'b2', event_id: 'e2', status: 'booked' },
    { location_id: HATCH, un1t_user_id: USER, un1t_id: 'b3', event_id: 'e3', status: 'cancelled' },
    { location_id: HATCH, un1t_user_id: USER, un1t_id: 'b-past', event_id: 'e-past', status: 'booked' },
    { location_id: HATCH, un1t_user_id: 'someone-else', un1t_id: 'bx', event_id: 'e3', status: 'booked' },
  ],
})

describe('executeUn1tRead: gates', () => {
  it('an unverified turn gets the not_verified object and reads nothing', async () => {
    const db = fakeDb(tables())
    for (const tool of ['get_my_membership', 'get_my_next_class', 'list_my_upcoming_bookings', 'get_my_recent_attendance']) {
      const out = await executeUn1tRead(tool, {}, ctxFor(db, { verifiedContactId: null }), [hatchStudio])
      expect(out).toEqual({ error: 'not_verified', message: 'Identity not verified yet. Call verify_identity first.' })
    }
    expect(db.calls).toEqual([])
    expect(fetchLiveUn1tBookings).not.toHaveBeenCalled()
  })
  it('an unknown tool, and no answerable studio, answer plainly', async () => {
    const db = fakeDb(tables())
    expect(await executeUn1tRead('request_refund', {}, ctxFor(db), [hatchStudio])).toEqual({ error: 'unknown_tool', tool: 'request_refund' })
    expect(await executeUn1tRead('get_my_membership', {}, ctxFor(db), [])).toMatchObject({ error: 'not_available_at_this_studio' })
  })
})

describe('executeUn1tRead: get_my_membership', () => {
  it('answers from the studio and user, with the credit balance now un1t.online declares credits (MIAHATCH.2)', async () => {
    const db = fakeDb(tables())
    const out = await executeUn1tRead('get_my_membership', {}, ctxFor(db), [hatchStudio])
    expect(out).toEqual({ status: 'active', plan: 'Monthly Foundation', price_label: '€189 a month', renews_on: 'Fri 20 Nov 2026', credits: 5 })
    // Every read is pinned to the studio; the subscription and client reads also to the user.
    for (const c of db.calls) expect(c.eqs.location_id).toBe(HATCH)
    for (const c of db.calls.filter((c) => c.table === 'un1t_subscriptions' || c.table === 'un1t_clients')) expect(c.eqs.un1t_user_id).toBe(USER)
  })
  it('the real un1t.online provider declares credits, and reports the balance or unlimited', async () => {
    expect(providerFor('un1t_online').capabilities.credits).toBe(true)
    const t = tables()
    t.un1t_clients[0] = { ...t.un1t_clients[0], credit_balance: 0, credit_unlimited: true }
    expect((await executeUn1tRead('get_my_membership', {}, ctxFor(fakeDb(t)), [hatchStudio])).credits).toBe('unlimited')
  })
  it('reports credits null when the studio source does not declare them', async () => {
    const real = providerFor.getMockImplementation()
    providerFor.mockImplementation((key) => ({ ...real(key), capabilities: { ...real(key).capabilities, credits: false } }))
    try {
      expect((await executeUn1tRead('get_my_membership', {}, ctxFor(fakeDb(tables())), [hatchStudio])).credits).toBeNull()
    } finally {
      providerFor.mockImplementation(real)
    }
  })
  it('with memberships and bookings capabilities false the four reads still answer (E-1)', async () => {
    const caps = providerFor('un1t_online').capabilities
    expect(caps.memberships).toBe(false)
    expect(caps.bookings).toBe(false)
    const db = fakeDb(tables())
    fetchLiveUn1tBookings.mockResolvedValue({ ok: true, rows: [{ id: 'b1', event_id: 'e1', status: 'booked' }] })
    const ctx = ctxFor(db)
    expect((await executeUn1tRead('get_my_membership', {}, ctx, [hatchStudio])).status).toBe('active')
    expect((await executeUn1tRead('get_my_next_class', {}, ctx, [hatchStudio])).found).toBe(true)
    expect((await executeUn1tRead('list_my_upcoming_bookings', {}, ctx, [hatchStudio])).bookings).toHaveLength(1)
    expect((await executeUn1tRead('get_my_recent_attendance', {}, ctx, [hatchStudio])).found).toBe(true)
  })
  it('a un1t studio with no un1tUserId is "no account found", read from nowhere', async () => {
    const db = fakeDb(tables())
    const noUser = { ...hatchStudio, un1tUserId: undefined }
    const out = await executeUn1tRead('get_my_membership', {}, ctxFor(db), [noUser])
    expect(out).toMatchObject({ status: 'none', plan: null, price_label: null, renews_on: null, credits: null, account_found: false })
    expect(out.message).toMatch(/No account was found/)
    expect(await executeUn1tRead('get_my_next_class', {}, ctxFor(db), [noUser])).toMatchObject({ found: false, account_found: false })
    expect(await executeUn1tRead('list_my_upcoming_bookings', {}, ctxFor(db), [noUser])).toMatchObject({ bookings: [], account_found: false })
    expect(await executeUn1tRead('get_my_recent_attendance', {}, ctxFor(db), [noUser])).toMatchObject({ found: false, account_found: false, total_attended_7d: null })
    expect(db.calls).toEqual([])
    expect(fetchLiveUn1tBookings).not.toHaveBeenCalled()
  })
  it('an unreadable subscription read is read_failed, never "no membership"', async () => {
    const out = await executeUn1tRead('get_my_membership', {}, ctxFor(fakeDb(tables(), { errors: { un1t_subscriptions: true } })), [hatchStudio])
    expect(out.error).toBe('read_failed')
    expect(out.status).toBeUndefined()
    expect(logWarn).toHaveBeenCalledWith('mia-un1t', expect.any(String), expect.objectContaining({ locationId: HATCH, code: 'XX000' }))
  })
  it('an unreadable client read: still answers a live membership, but never "none"', async () => {
    const db = fakeDb(tables(), { errors: { un1t_clients: true } })
    expect((await executeUn1tRead('get_my_membership', {}, ctxFor(db), [hatchStudio])).status).toBe('active')
    const t = tables()
    t.un1t_subscriptions = []
    expect((await executeUn1tRead('get_my_membership', {}, ctxFor(fakeDb(t, { errors: { un1t_clients: true } })), [hatchStudio])).error).toBe('read_failed')
  })
  it('"none" from the mirror carries a staleness note (a purchase minutes old may not show)', async () => {
    const t = tables()
    t.un1t_subscriptions = []
    const out = await executeUn1tRead('get_my_membership', {}, ctxFor(fakeDb(t)), [hatchStudio])
    expect(out).toMatchObject({ status: 'none', plan: null })
    expect(out.message).toMatch(/few minutes behind/)
    expect(out.message).toMatch(/very recent purchase/)
    expect(out.message).not.toMatch(/[\u2013\u2014]/)
    // a live membership gets no such note
    expect((await executeUn1tRead('get_my_membership', {}, ctxFor(fakeDb(tables())), [hatchStudio])).message).toBeUndefined()
  })
  it('an unreadable product read still answers from the subscription', async () => {
    const out = await executeUn1tRead('get_my_membership', {}, ctxFor(fakeDb(tables(), { errors: { un1t_products: true } })), [hatchStudio])
    expect(out).toMatchObject({ status: 'active', plan: 'Monthly Foundation' })
  })
})

describe('executeUn1tRead: bookings and next class', () => {
  const liveRows = [
    { id: 'b1', event_id: 'e1', status: 'booked' },
    { id: 'b2', event_id: 'e2', status: 'booked' },
    { id: 'b3', event_id: 'e3', status: 'cancelled' },
    { id: 'b-past', event_id: 'e-past', status: 'booked' },
  ]
  it('live first: future booked rows joined to events, ids tagged, no stale flag', async () => {
    fetchLiveUn1tBookings.mockResolvedValue({ ok: true, rows: liveRows })
    const db = fakeDb(tables())
    const out = await executeUn1tRead('list_my_upcoming_bookings', {}, ctxFor(db), [hatchStudio])
    expect(fetchLiveUn1tBookings).toHaveBeenCalledWith(db, { locationId: HATCH, un1tUserId: USER })
    expect(out).toEqual({
      bookings: [
        { booking_id: 'un1t:b1', class_name: 'HYROX', starts_at: formatClassTime(Math.floor((NOW + DAY) / 1000), 'Europe/Dublin') },
        { booking_id: 'un1t:b2', class_name: 'Strength', starts_at: formatClassTime(Math.floor((NOW + 2 * DAY) / 1000), 'Europe/Dublin') },
      ],
    })
    // The mirror bookings table was not needed.
    expect(db.calls.some((c) => c.table === 'un1t_bookings')).toBe(false)
  })
  it.each([
    ['not_connected'], ['read_failed'], ['budget_spent'],
  ])('live read %s -> the mirror, with may_be_stale: true', async (reason) => {
    fetchLiveUn1tBookings.mockResolvedValue({ ok: false, reason })
    const out = await executeUn1tRead('list_my_upcoming_bookings', {}, ctxFor(fakeDb(tables())), [hatchStudio])
    expect(out.may_be_stale).toBe(true)
    expect(out.bookings.map((b) => b.booking_id)).toEqual(['un1t:b1', 'un1t:b2'])
    expect(out.message).toMatch(/few minutes behind/)
  })
  it('a booking at a cancelled class is not upcoming, on the live path and the mirror path', async () => {
    const t = tables()
    t.un1t_events.find((e) => e.un1t_id === 'e2').status = 'cancelled'
    fetchLiveUn1tBookings.mockResolvedValue({ ok: true, rows: liveRows })
    const live = await executeUn1tRead('list_my_upcoming_bookings', {}, ctxFor(fakeDb(t)), [hatchStudio])
    expect(live.bookings.map((b) => b.booking_id)).toEqual(['un1t:b1'])
    expect((await executeUn1tRead('get_my_next_class', {}, ctxFor(fakeDb(t)), [hatchStudio])).booking_id).toBe('un1t:b1')
    fetchLiveUn1tBookings.mockResolvedValue({ ok: false, reason: 'read_failed' })
    const mirror = await executeUn1tRead('list_my_upcoming_bookings', {}, ctxFor(fakeDb(t)), [hatchStudio])
    expect(mirror.bookings.map((b) => b.booking_id)).toEqual(['un1t:b1'])
  })
  it('the cancelled-class filter uses the same scheduled literal as the timetable', async () => {
    const { UN1T_SCHEDULED_STATUS } = await import('./booking-tools')
    expect(UN1T_EVENT_SCHEDULED_STATUS).toBe(UN1T_SCHEDULED_STATUS)
  })
  it('a thrown live read also falls back to the mirror, stale', async () => {
    fetchLiveUn1tBookings.mockRejectedValue(new Error('network'))
    const out = await executeUn1tRead('list_my_upcoming_bookings', {}, ctxFor(fakeDb(tables())), [hatchStudio])
    expect(out.may_be_stale).toBe(true)
    expect(out.bookings).toHaveLength(2)
  })
  it('the mirror fallback only reads this user and this studio', async () => {
    fetchLiveUn1tBookings.mockResolvedValue({ ok: false, reason: 'read_failed' })
    const db = fakeDb(tables())
    const out = await executeUn1tRead('list_my_upcoming_bookings', {}, ctxFor(db), [hatchStudio])
    expect(out.bookings.map((b) => b.booking_id)).not.toContain('un1t:bx')
    const c = db.calls.find((x) => x.table === 'un1t_bookings')
    expect(c.eqs).toMatchObject({ location_id: HATCH, un1t_user_id: USER, status: 'booked' })
  })
  it('a truncated live list is topped up from the mirror for events it did not name, stale', async () => {
    // The live list names only e1; the mirror also has the future booked e2.
    fetchLiveUn1tBookings.mockResolvedValue({ ok: true, truncated: true, rows: [{ id: 'b1', event_id: 'e1', status: 'booked' }] })
    const out = await executeUn1tRead('list_my_upcoming_bookings', {}, ctxFor(fakeDb(tables())), [hatchStudio])
    expect(out.may_be_stale).toBe(true)
    expect(out.bookings.map((b) => b.booking_id)).toEqual(['un1t:b1', 'un1t:b2'])
  })
  it('an event the mirror does not know yet: the live row\'s own event, else flagged stale', async () => {
    fetchLiveUn1tBookings.mockResolvedValue({
      ok: true,
      rows: [
        { id: 'b1', event_id: 'e1', status: 'booked' },
        { id: 'b9', event_id: 'e-new', status: 'booked', event: { id: 'e-new', title: 'Fresh Class', start_time: iso(NOW + 4 * DAY) } },
        { id: 'b10', event_id: 'e-unsynced', status: 'booked' },
      ],
    })
    const out = await executeUn1tRead('list_my_upcoming_bookings', {}, ctxFor(fakeDb(tables())), [hatchStudio])
    expect(out.bookings.map((b) => b.class_name)).toEqual(['HYROX', 'Fresh Class'])
    expect(out.may_be_stale).toBe(true)
  })
  it('an unreadable mirror is list_failed, never "no bookings"', async () => {
    fetchLiveUn1tBookings.mockResolvedValue({ ok: false, reason: 'budget_spent' })
    const out = await executeUn1tRead('list_my_upcoming_bookings', {}, ctxFor(fakeDb(tables(), { errors: { un1t_bookings: true } })), [hatchStudio])
    expect(out.error).toBe('list_failed')
    expect(out.bookings).toBeUndefined()
    const events = await executeUn1tRead('list_my_upcoming_bookings', {}, ctxFor(fakeDb(tables(), { errors: { un1t_events: true } })), [hatchStudio])
    expect(events.error).toBe('list_failed')
  })
  it('nothing booked reads as an empty list, with a message; stale says so', async () => {
    fetchLiveUn1tBookings.mockResolvedValue({ ok: true, rows: [] })
    expect(await executeUn1tRead('list_my_upcoming_bookings', {}, ctxFor(fakeDb(tables())), [hatchStudio]))
      .toEqual({ bookings: [], message: 'No upcoming bookings found for this member.' })
    fetchLiveUn1tBookings.mockResolvedValue({ ok: false, reason: 'read_failed' })
    const t = tables()
    t.un1t_bookings = []
    const stale = await executeUn1tRead('list_my_upcoming_bookings', {}, ctxFor(fakeDb(t)), [hatchStudio])
    expect(stale).toMatchObject({ bookings: [], may_be_stale: true })
    expect(stale.message).toMatch(/few minutes behind/)
  })
  it('get_my_next_class: the soonest booking, in the same shape as the Glofox answer', async () => {
    fetchLiveUn1tBookings.mockResolvedValue({ ok: true, rows: liveRows })
    const out = await executeUn1tRead('get_my_next_class', {}, ctxFor(fakeDb(tables())), [hatchStudio])
    expect(out).toEqual({ found: true, class_name: 'HYROX', class_time: formatClassTime(Math.floor((NOW + DAY) / 1000), 'Europe/Dublin'), booking_id: 'un1t:b1' })
    fetchLiveUn1tBookings.mockResolvedValue({ ok: true, rows: [] })
    expect(await executeUn1tRead('get_my_next_class', {}, ctxFor(fakeDb(tables())), [hatchStudio])).toEqual({ found: false })
  })
  it('get_my_next_class on the mirror is stale; an unreadable one is read_failed', async () => {
    fetchLiveUn1tBookings.mockResolvedValue({ ok: false, reason: 'budget_spent' })
    expect(await executeUn1tRead('get_my_next_class', {}, ctxFor(fakeDb(tables())), [hatchStudio])).toMatchObject({ found: true, may_be_stale: true })
    expect((await executeUn1tRead('get_my_next_class', {}, ctxFor(fakeDb(tables(), { errors: { un1t_bookings: true } })), [hatchStudio])).error).toBe('read_failed')
  })
  it('renders class times in the studio zone, not the machine zone', async () => {
    fetchLiveUn1tBookings.mockResolvedValue({ ok: true, rows: [{ id: 'b1', event_id: 'e1', status: 'booked' }] })
    const out = await executeUn1tRead('list_my_upcoming_bookings', {}, ctxFor(fakeDb(tables()), { zone: 'America/New_York' }), [hatchStudio])
    expect(out.bookings[0].starts_at).toBe(formatClassTime(Math.floor((NOW + DAY) / 1000), 'America/New_York'))
    expect(out.bookings[0].starts_at).not.toBe(formatClassTime(Math.floor((NOW + DAY) / 1000), 'Europe/Dublin'))
  })
})

describe('executeUn1tRead: get_my_recent_attendance', () => {
  it('reads the client counters; 7-day is null with the note; no no-show anywhere', async () => {
    const db = fakeDb(tables())
    const out = await executeUn1tRead('get_my_recent_attendance', {}, ctxFor(db), [hatchStudio])
    expect(out).toEqual({ found: true, total_attended_30d: 8, last_attended_on: 'Fri 16 Oct 2026', total_attended_7d: null, note: 'no 7-day count at this studio; never state one' })
    expect(db.calls.map((c) => c.cols).join(' ')).not.toMatch(/no_show/)
  })
  it('an unreadable client row is read_failed', async () => {
    expect((await executeUn1tRead('get_my_recent_attendance', {}, ctxFor(fakeDb(tables(), { errors: { un1t_clients: true } })), [hatchStudio])).error).toBe('read_failed')
  })
})

describe('executeUn1tRead: two answerable studios', () => {
  const dualCtx = (db, over = {}) => ctxFor(db, { turn: { block: 'un1t_read_dual', answerable: [hatchStudio, stillStudio], channel: 'whatsapp', un1tWrites: false }, ...over })

  it('one named section each; the Glofox half is today\'s executor at the Glofox studio, with no turn', async () => {
    executeAccountTool.mockResolvedValueOnce({ found: true, status: 'active', plan: 'Glofox Plan' })
    const ctx = dualCtx(fakeDb({ ...tables(), locations: [{ id: STILL, timezone: 'Europe/Dublin' }] }))
    const out = await executeUn1tRead('get_my_membership', {}, ctx, [hatchStudio, stillStudio])
    expect(out).toEqual({
      studios: [
        { studio: 'Test Studio Hatch', status: 'active', plan: 'Monthly Foundation', price_label: '€189 a month', renews_on: 'Fri 20 Nov 2026', credits: 5 },
        { studio: 'Test Studio Still', found: true, status: 'active', plan: 'Glofox Plan' },
      ],
    })
    expect(executeAccountTool).toHaveBeenCalledTimes(1)
    const [name, , glofoxCtx] = executeAccountTool.mock.calls[0]
    expect(name).toBe('get_my_membership')
    expect(glofoxCtx.locationId).toBe(STILL)
    expect(glofoxCtx.turn).toBeUndefined()
    expect(glofoxCtx.verifiedContactId).toBe('c-h')
  })
  it('list_my_upcoming_bookings sends the Glofox half through executeBookingTool', async () => {
    executeBookingTool.mockResolvedValueOnce({ bookings: [{ booking_id: '64bb00000000000000000001', class_name: 'Glofox Class', time: 'Mon 19 Oct, 07:00' }] })
    fetchLiveUn1tBookings.mockResolvedValue({ ok: true, rows: [{ id: 'b1', event_id: 'e1', status: 'booked' }] })
    const out = await executeUn1tRead('list_my_upcoming_bookings', {}, dualCtx(fakeDb({ ...tables(), locations: [] })), [hatchStudio, stillStudio])
    expect(out.studios.map((s) => s.studio)).toEqual(['Test Studio Hatch', 'Test Studio Still'])
    expect(out.studios[0].bookings[0].booking_id).toBe('un1t:b1')
    expect(out.studios[1].bookings[0].class_name).toBe('Glofox Class')
    expect(executeBookingTool.mock.calls[0][2]).toMatchObject({ locationId: STILL, turn: undefined })
  })
  it('the other studio\'s own zone is read from its location row', async () => {
    executeAccountTool.mockResolvedValueOnce({ found: false })
    const db = fakeDb({ ...tables(), locations: [{ id: STILL, timezone: 'America/New_York' }] })
    await executeUn1tRead('get_my_next_class', {}, dualCtx(db), [hatchStudio, stillStudio])
    expect(executeAccountTool.mock.calls[0][2].zone).toBe('America/New_York')
  })
  it('a failing section is that section\'s error; the other still answers', async () => {
    executeAccountTool.mockRejectedValueOnce(new Error('glofox down'))
    const out = await executeUn1tRead('get_my_membership', {}, dualCtx(fakeDb({ ...tables(), locations: [] })), [hatchStudio, stillStudio])
    expect(out.studios[0]).toMatchObject({ studio: 'Test Studio Hatch', status: 'active' })
    expect(out.studios[1]).toMatchObject({ studio: 'Test Studio Still', error: 'read_failed' })
  })
})

describe('what the model sees', () => {
  it('never carries capacity, headcount or a full flag, and no select names them', async () => {
    fetchLiveUn1tBookings.mockResolvedValue({ ok: true, rows: [{ id: 'b1', event_id: 'e1', status: 'booked' }] })
    const db = fakeDb(tables())
    const ctx = ctxFor(db)
    const results = []
    for (const tool of ['get_my_membership', 'get_my_next_class', 'list_my_upcoming_bookings', 'get_my_recent_attendance']) {
      results.push(await executeUn1tRead(tool, {}, ctx, [hatchStudio]))
    }
    fetchLiveUn1tBookings.mockResolvedValue({ ok: false, reason: 'budget_spent' })
    results.push(await executeUn1tRead('list_my_upcoming_bookings', {}, ctx, [hatchStudio]))
    const json = JSON.stringify(results)
    expect(json).not.toMatch(/capacity|bookings_count|headcount|spaces|full/i)
    for (const c of db.calls) expect(c.cols || '').not.toMatch(/capacity|bookings_count/)
  })
  it('no em or en dash in anything the executor returns', async () => {
    const db = fakeDb(tables())
    const outs = []
    for (const fail of [null, 'budget_spent']) {
      fetchLiveUn1tBookings.mockResolvedValue(fail ? { ok: false, reason: fail } : { ok: true, rows: [] })
      for (const tool of ['get_my_membership', 'get_my_next_class', 'list_my_upcoming_bookings', 'get_my_recent_attendance']) {
        outs.push(await executeUn1tRead(tool, {}, ctxFor(db), [hatchStudio]))
        outs.push(await executeUn1tRead(tool, {}, ctxFor(db), [{ ...hatchStudio, un1tUserId: undefined }]))
        outs.push(await executeUn1tRead(tool, {}, ctxFor(fakeDb(tables(), { errors: { un1t_subscriptions: true, un1t_clients: true, un1t_bookings: true, un1t_events: true } })), [hatchStudio]))
      }
    }
    expect(JSON.stringify(outs)).not.toMatch(/[–—]/)
  })
  it('logs carry the studio and a code, never an id of the member', async () => {
    await executeUn1tRead('get_my_membership', {}, ctxFor(fakeDb(tables(), { errors: { un1t_subscriptions: true } })), [hatchStudio])
    expect(JSON.stringify(logWarn.mock.calls)).not.toContain(USER)
  })
})

// ── MIAHATCH.3: the payment reminder at a un1t.online studio ─────────
describe('executeUn1tRead: get_my_payment_reminder', () => {
  const pastDueFn = vi.fn()
  const CAPS_ON = { memberships: false, bookings: false, credits: true, invoices: true, schedule: false }
  const seam = (over = {}) => ({
    source: 'un1t_online', label: 'un1t.online', state: 'configured', error: null, capabilities: CAPS_ON,
    reads: { pastDue: pastDueFn }, ...over,
  })
  const row = (over = {}) => ({
    contactId: 'c-h', un1tUserId: USER, subscriptionId: 'sub-1', productTitle: 'Monthly Foundation',
    since: '2026-10-10T08:00:00Z', amountCents: 18900, currency: 'EUR', openInvoiceIds: ['inv-1'],
    cancelAtPeriodEnd: false, pausedUntil: null, ...over,
  })
  const run = (studios = [hatchStudio], over = {}) => executeUn1tRead('get_my_payment_reminder', {}, ctxFor(fakeDb({}), over), studios)

  beforeEach(() => {
    pastDueFn.mockReset()
    membershipReadsFor.mockReset()
    membershipReadsFor.mockResolvedValue(seam())
    pastDueFn.mockResolvedValue({ success: true, data: [] })
  })

  it('invoices false: still_overdue unknown, and pastDue is not called', async () => {
    membershipReadsFor.mockResolvedValue(seam({ capabilities: { ...CAPS_ON, invoices: false } }))
    expect(await run()).toEqual({ has_reminder: false, still_overdue: 'unknown' })
    expect(pastDueFn).not.toHaveBeenCalled()
  })

  it('a seam without pastDue (or no adapter): unknown', async () => {
    membershipReadsFor.mockResolvedValue(seam({ reads: {} }))
    expect(await run()).toEqual({ has_reminder: false, still_overdue: 'unknown' })
    membershipReadsFor.mockResolvedValue(seam({ state: 'unconfigured', reads: null }))
    expect(await run()).toEqual({ has_reminder: false, still_overdue: 'unknown' })
    expect(pastDueFn).not.toHaveBeenCalled()
  })

  it('a past due row: still_overdue true with since (studio zone) and the amount label', async () => {
    pastDueFn.mockResolvedValue({ success: true, data: [row()] })
    expect(await run()).toEqual({ has_reminder: false, still_overdue: true, since: 'Sat 10 Oct 2026', amount_label: '€189' })
  })

  it('an amount with cents keeps them; a null amount gives no amount_label', async () => {
    pastDueFn.mockResolvedValue({ success: true, data: [row({ amountCents: 1250 })] })
    expect((await run()).amount_label).toBe('€12.50')
    pastDueFn.mockResolvedValue({ success: true, data: [row({ amountCents: null, currency: null })] })
    const out = await run()
    expect(out).toEqual({ has_reminder: false, still_overdue: true, since: 'Sat 10 Oct 2026' })
    expect(out).not.toHaveProperty('amount_label')
  })

  it('a null since gives no since', async () => {
    pastDueFn.mockResolvedValue({ success: true, data: [row({ since: null })] })
    expect(await run()).toEqual({ has_reminder: false, still_overdue: true, amount_label: '€189' })
  })

  it('two rows: the earliest since, and a summed amount only when every amount is known in one currency', async () => {
    pastDueFn.mockResolvedValue({ success: true, data: [row({ since: '2026-10-01T08:00:00Z', amountCents: 1000 }), row({ subscriptionId: 'sub-2', since: '2026-10-12T08:00:00Z', amountCents: 500 })] })
    expect(await run()).toEqual({ has_reminder: false, still_overdue: true, since: 'Thu 1 Oct 2026', amount_label: '€15' })
    pastDueFn.mockResolvedValue({ success: true, data: [row({ amountCents: 1000 }), row({ subscriptionId: 'sub-2', amountCents: null })] })
    expect(await run()).not.toHaveProperty('amount_label')
    pastDueFn.mockResolvedValue({ success: true, data: [row({ amountCents: 1000 }), row({ subscriptionId: 'sub-2', amountCents: 500, currency: 'GBP' })] })
    expect(await run()).not.toHaveProperty('amount_label')
  })

  it('an empty answer: still_overdue false', async () => {
    expect(await run()).toEqual({ has_reminder: false, still_overdue: false })
  })

  it('a failed read (success false, or a throw): unknown, logged with a status and class only', async () => {
    pastDueFn.mockResolvedValue({ success: false, error: `relation ${USER} does not exist` })
    expect(await run()).toEqual({ has_reminder: false, still_overdue: 'unknown' })
    pastDueFn.mockRejectedValue(new TypeError(`boom ${USER}`))
    expect(await run()).toEqual({ has_reminder: false, still_overdue: 'unknown' })
    membershipReadsFor.mockRejectedValue(new RangeError('seam down'))
    expect(await run()).toEqual({ has_reminder: false, still_overdue: 'unknown' })
    expect(logWarn).toHaveBeenCalled()
    for (const [mod, , fields] of logWarn.mock.calls) {
      expect(mod).toBe('mia-un1t')
      expect(Object.keys(fields).sort()).toEqual(['errClass', 'locationId', 'op', 'status'])
    }
    expect(JSON.stringify(logWarn.mock.calls)).not.toContain(USER)
  })

  it('contactIds is the studio\'s person group; rows of another un1t account are dropped', async () => {
    const studio = { ...hatchStudio, contactIds: ['c-h', 'c-h2'] }
    pastDueFn.mockResolvedValue({ success: true, data: [row({ un1tUserId: 'someone-else', amountCents: 99900 })] })
    expect(await run([studio])).toEqual({ has_reminder: false, still_overdue: false })
    expect(pastDueFn).toHaveBeenCalledWith(expect.anything(), HATCH, { contactIds: ['c-h', 'c-h2'] })
    expect(membershipReadsFor).toHaveBeenCalledWith(expect.anything(), HATCH)
  })

  it('no un1t account or no group contacts: unknown without asking the seam', async () => {
    expect(await run([{ ...hatchStudio, un1tUserId: undefined }])).toMatchObject({ has_reminder: false, still_overdue: 'unknown', account_found: false })
    expect(await run([{ ...hatchStudio, contactIds: [] }])).toEqual({ has_reminder: false, still_overdue: 'unknown' })
    expect(pastDueFn).not.toHaveBeenCalled()
  })

  it('an unverified turn gets not_verified and reads nothing', async () => {
    expect(await run([hatchStudio], { verifiedContactId: null })).toEqual({ error: 'not_verified', message: 'Identity not verified yet. Call verify_identity first.' })
    expect(membershipReadsFor).not.toHaveBeenCalled()
  })

  it('never carries a pay link, a url, capacity or a dash', async () => {
    pastDueFn.mockResolvedValue({ success: true, data: [row()] })
    const json = JSON.stringify([await run(), await run([{ ...hatchStudio, un1tUserId: undefined }])])
    expect(json).not.toMatch(/pay_link|https?:|capacity|[–—]/i)
  })

  it('never makes a Glofox call at a un1t studio', async () => {
    pastDueFn.mockResolvedValue({ success: true, data: [row()] })
    await run()
    await run([hatchStudio], { turn: { block: 'un1t_read_dual', answerable: [hatchStudio], channel: 'whatsapp', un1tWrites: false } })
    expect(executeAccountTool).not.toHaveBeenCalled()
    expect(executeBookingTool).not.toHaveBeenCalled()
  })

  it('two studios: the Glofox section is today\'s executor at the Glofox studio, the un1t section the new shape', async () => {
    pastDueFn.mockResolvedValue({ success: true, data: [row()] })
    const reminder = { has_reminder: true, status: 'active', amount: '€59', currency: 'EUR', pay_link: 'https://pay.example.test/x', still_overdue: false }
    executeAccountTool.mockResolvedValueOnce(reminder)
    const ctx = ctxFor(fakeDb({ locations: [{ id: STILL, timezone: 'Europe/Dublin' }] }), { turn: { block: 'un1t_read_dual', answerable: [hatchStudio, stillStudio], channel: 'whatsapp', un1tWrites: false } })
    const out = await executeUn1tRead('get_my_payment_reminder', {}, ctx, [hatchStudio, stillStudio])
    expect(out).toEqual({
      studios: [
        { studio: 'Test Studio Hatch', has_reminder: false, still_overdue: true, since: 'Sat 10 Oct 2026', amount_label: '€189' },
        { studio: 'Test Studio Still', ...reminder },
      ],
    })
    expect(executeAccountTool).toHaveBeenCalledTimes(1)
    const [name, , glofoxCtx] = executeAccountTool.mock.calls[0]
    expect(name).toBe('get_my_payment_reminder')
    expect(glofoxCtx.locationId).toBe(STILL)
    expect(glofoxCtx.turn).toBeUndefined()
    expect(membershipReadsFor).toHaveBeenCalledTimes(1)
    expect(membershipReadsFor).toHaveBeenCalledWith(expect.anything(), HATCH)
  })

  it('two studios: a un1t failure is only that section', async () => {
    membershipReadsFor.mockRejectedValue(new Error('seam down'))
    executeAccountTool.mockResolvedValueOnce({ has_reminder: false, status: 'none', still_overdue: 'unknown' })
    const ctx = ctxFor(fakeDb({ locations: [] }), { turn: { block: 'un1t_read_dual', answerable: [hatchStudio, stillStudio], channel: 'whatsapp', un1tWrites: false } })
    const out = await executeUn1tRead('get_my_payment_reminder', {}, ctx, [hatchStudio, stillStudio])
    expect(out.studios[0]).toEqual({ studio: 'Test Studio Hatch', has_reminder: false, still_overdue: 'unknown' })
    expect(out.studios[1]).toMatchObject({ studio: 'Test Studio Still', has_reminder: false })
  })
})

// ── Task 6: the timetable with event ids and `full` ──────────────────
describe('shapeUn1tTimetableForAgent', () => {
  const row = (over = {}) => ({ un1t_id: 'e1', title: 'HYROX', starts_at: '2026-10-20T07:00:00Z', capacity: 12, bookings_count: 3, ...over })

  it('payload keys are exactly event_id, name, starts_at, full', () => {
    const rows = [row(), row({ un1t_id: 'e2', capacity: 12, bookings_count: 12 }), row({ un1t_id: 'e3', capacity: null }), row({ un1t_id: 'e4', capacity: 0, bookings_count: 4 })]
    const out = shapeUn1tTimetableForAgent(rows, 'Europe/Dublin')
    expect(out).toHaveLength(4)
    for (const item of out) expect(Object.keys(item)).toEqual(['event_id', 'name', 'starts_at', 'full'])
    expect(out[0]).toEqual({ event_id: 'un1t:e1', name: 'HYROX', starts_at: 'Tue 20 Oct, 08:00', full: false })
    expect(JSON.stringify(out)).not.toMatch(/capacity|bookings_count|limited|spaces/)
  })
  it('full true at capacity and over it, false below, false when capacity is 0 or null', () => {
    const at = (capacity, bookings_count) => shapeUn1tTimetableForAgent([row({ capacity, bookings_count })], 'Europe/Dublin')[0].full
    expect(at(12, 12)).toBe(true)
    expect(at(12, 15)).toBe(true)
    expect(at(12, 11)).toBe(false)
    expect(at(12, 0)).toBe(false)
    expect(at(12, null)).toBe(false)
    expect(at(0, 3)).toBe(false)
    expect(at(null, 3)).toBe(false)
    expect(at(undefined, undefined)).toBe(false)
  })
  it('drops a row with no id or no parseable start; a blank title is "Class"; uses the zone', () => {
    const out = shapeUn1tTimetableForAgent([row({ un1t_id: null }), row({ starts_at: 'nope' }), row({ title: '  ' })], 'America/New_York')
    expect(out).toEqual([{ event_id: 'un1t:e1', name: 'Class', starts_at: 'Tue 20 Oct, 03:00', full: false }])
  })
  it('a non-array is an empty list', () => {
    expect(shapeUn1tTimetableForAgent(null, 'Europe/Dublin')).toEqual([])
  })
})

describe('executeUn1tTimetable: two answerable studios', () => {
  const dualCtx = (db) => ctxFor(db, { turn: { block: 'un1t_read_dual', answerable: [hatchStudio, stillStudio], channel: 'whatsapp', un1tWrites: false } })

  it('one named section each, the Glofox half is today\'s path at the Glofox studio with no turn', async () => {
    executeBookingTool.mockResolvedValueOnce({ classes: [{ event_id: '64cc00000000000000000001', name: 'Glofox Class', time: 'Mon 19 Oct, 07:00', starts_at: '2026-10-19T07:00:00.000Z', full: false }] })
    const db = fakeDb({ ...tables(), locations: [{ id: STILL, timezone: 'Europe/Dublin' }] })
    const out = await executeUn1tTimetable({}, dualCtx(db), [hatchStudio, stillStudio])
    expect(out.studios.map((s) => s.studio)).toEqual(['Test Studio Hatch', 'Test Studio Still'])
    expect(out.studios[0].classes.map((c) => c.event_id)).toEqual(['un1t:e1', 'un1t:e2', 'un1t:e3'])
    expect(out.studios[0].classes[0].full).toBe(true)
    expect(out.studios[1].classes[0].name).toBe('Glofox Class')
    const glofoxCall = executeBookingTool.mock.calls.find((c) => c[2].locationId === STILL)
    expect(glofoxCall[0]).toBe('list_upcoming_classes')
    expect(glofoxCall[2].turn).toBeUndefined()
  })
  it('two studios: a failed un1t read is that section\'s handoff; the Glofox half still answers', async () => {
    executeBookingTool.mockResolvedValueOnce({ classes: [] })
    const db = fakeDb({ ...tables(), locations: [] }, { errors: { un1t_events: true } })
    const out = await executeUn1tTimetable({}, dualCtx(db), [hatchStudio, stillStudio])
    expect(out.studios[0]).toMatchObject({ studio: 'Test Studio Hatch', error: 'no_booking_system' })
    expect(out.studios[1]).toEqual({ studio: 'Test Studio Still', classes: [] })
  })
})

describe('list_upcoming_classes in a un1t block', () => {
  const run = (db, turn, over = {}) => executeBookingTool('list_upcoming_classes', {}, ctxFor(db, { turn, ...over }))
  const readTurn = { block: 'un1t_read', answerable: [hatchStudio], channel: 'whatsapp', un1tWrites: false }
  it('answers { classes: [{ event_id, name, starts_at, full }] } with full set from capacity, never the numbers', async () => {
    const db = fakeDb(tables())
    const out = await run(db, readTurn)
    expect(Object.keys(out)).toEqual(['classes'])
    expect(out.classes.map((c) => c.name)).toEqual(['HYROX', 'Strength', 'Mobility'])
    expect(out.classes.map((c) => c.full)).toEqual([true, false, false])
    expect(out.classes.map((c) => c.event_id)).toEqual(['un1t:e1', 'un1t:e2', 'un1t:e3'])
    for (const item of out.classes) expect(Object.keys(item)).toEqual(['event_id', 'name', 'starts_at', 'full'])
    expect(JSON.stringify(out)).not.toMatch(/capacity|bookings_count|limited/)
    const read = db.calls.find((c) => c.table === 'un1t_events')
    expect(read.cols).toBe('un1t_id, title, starts_at, capacity, bookings_count')
    expect(read.eqs).toMatchObject({ location_id: HATCH, status: 'scheduled' })
  })
  it('needs no verification (the public timetable)', async () => {
    const out = await run(fakeDb(tables()), readTurn, { verifiedContactId: null })
    expect(out.classes).toHaveLength(3)
  })
  it('is dispatched to the answerable un1t studio, not the thread studio', async () => {
    // A Hatch-only member on a Stillorgan thread: ctx.locationId is Stillorgan.
    const stillThread = { zone: 'Europe/Dublin', locationId: STILL }
    const db = fakeDb({ ...tables(), locations: [{ id: HATCH, timezone: 'Europe/Dublin' }] })
    const out = await run(db, readTurn, stillThread)
    const read = db.calls.find((c) => c.table === 'un1t_events')
    expect(read.eqs.location_id).toBe(HATCH)
    expect(out.classes).toHaveLength(3)
  })
  it('the studio\'s own zone is used when it is not the thread studio', async () => {
    const db = fakeDb({ ...tables(), locations: [{ id: HATCH, timezone: 'America/New_York' }] })
    const out = await run(db, readTurn, { locationId: STILL, zone: 'Europe/Dublin' })
    expect(out.classes[0].starts_at).toBe(formatClassTime(Math.floor((NOW + DAY) / 1000), 'America/New_York'))
  })
  it('a full page says truncated: true', async () => {
    const many = Array.from({ length: UN1T_TIMETABLE_LIMIT }, (_, i) => ({ location_id: HATCH, un1t_id: `m${i}`, title: `C${i}`, starts_at: iso(NOW + DAY + i * 60_000), status: 'scheduled', capacity: 12, bookings_count: 1 }))
    const out = await run(fakeDb({ un1t_events: many }), readTurn)
    expect(Object.keys(out)).toEqual(['classes', 'truncated'])
    expect(out.truncated).toBe(true)
    expect(out.classes).toHaveLength(UN1T_TIMETABLE_LIMIT)
  })
  it('a failed read hands off like the no-booking block, never an empty list', async () => {
    const db = fakeDb(tables(), { errors: { un1t_events: true } })
    const out = await run(db, readTurn)
    expect(out).toEqual(noBookingSystemAnswer(null, { state: 'none' }))
    expect(out.classes).toBeUndefined()
  })
  it('a turn with no un1t studio answerable is the not-at-this-studio refusal', async () => {
    const out = await run(fakeDb(tables()), { ...readTurn, answerable: [stillStudio] })
    expect(out).toEqual({ ...TOOL_NOT_AT_THIS_STUDIO })
  })
  it('no em or en dash in what the timetable itself adds', async () => {
    // (The failed-read handoff is the existing no_booking_system message.)
    const out = await run(fakeDb(tables()), readTurn)
    expect(JSON.stringify(out)).not.toMatch(/[–—]/)
  })
})
