import { describe, it, expect } from 'vitest'
import { loadUn1tOnlineJourneyLane } from './onboarding-journey-un1t'

// PULSEUN1T.1 — the /pulse lane at a un1t.online studio. Members come from the
// membership facts on contact_studios (the un1t sync's), their join day from
// the un1t.online subscription mirror (contact_studios.membership_since is the
// day the sync first SAW them, not the day they joined), and attendance from
// the un1t.online class_bookings projection.

// PostgREST-faithful chainable mock (same semantics as
// onboarding-journey-data.test.js): filters, order and range really apply;
// NULL never satisfies .gte or .not('eq'); { __error } resolves an error.
function makeDb(tables) {
  const queries = []
  function builder(table) {
    const filters = []
    const calls = []
    queries.push({ table, calls })
    const orders = []
    let rangeSpec = null
    let single = false
    const b = {
      select() { return b },
      eq(col, val) { calls.push(['eq', col, val]); filters.push((r) => r[col] === val); return b },
      in(col, vals) { filters.push((r) => vals.includes(r[col])); return b },
      gte(col, val) { filters.push((r) => r[col] != null && String(r[col]) >= String(val)); return b },
      not(col, op, val) {
        if (op === 'eq') filters.push((r) => r[col] != null && r[col] !== val)
        else if (op === 'is') filters.push((r) => r[col] !== val)
        return b
      },
      order(col, opts = {}) { orders.push({ col, asc: opts.ascending !== false }); return b },
      range(from, to) { rangeSpec = [from, to]; return b },
      maybeSingle() { single = true; return b },
      then(resolve, reject) {
        const src = tables[table]
        if (src && src.__error) {
          return Promise.resolve({ data: null, error: { message: src.__error } }).then(resolve, reject)
        }
        let rows = (Array.isArray(src) ? src : []).filter((r) => filters.every((f) => f(r)))
        for (let i = orders.length - 1; i >= 0; i--) {
          const { col, asc } = orders[i]
          rows = [...rows].sort((a, z) => (a[col] === z[col] ? 0 : (a[col] > z[col] ? 1 : -1) * (asc ? 1 : -1)))
        }
        if (rangeSpec) rows = rows.slice(rangeSpec[0], rangeSpec[1] + 1)
        const value = single ? { data: rows[0] ?? null, error: null } : { data: rows, error: null }
        return Promise.resolve(value).then(resolve, reject)
      },
    }
    return b
  }
  return { queries, from: (table) => builder(table) }
}

const HATCH = 'loc-hatch'
const OTHER = 'loc-other'
const NOW = Date.parse('2026-10-27T12:00:00Z')

const location = [{ id: HATCH, notification_config: null, timezone: 'Europe/Dublin' }]
const studio = (contact_id, over = {}) => ({ contact_id, location_id: HATCH, membership_status: 'active', ...over })
let subSeq = 0
const sub = (contact_id, remote_created_at, over = {}) => ({
  id: `s-${String(++subSeq).padStart(4, '0')}`, contact_id, location_id: HATCH, remote_created_at, ...over,
})
let bookingSeq = 0
const booking = (contact_id, starts_at, over = {}) => ({
  id: `b-${String(++bookingSeq).padStart(5, '0')}`, contact_id, location_id: HATCH, starts_at,
  attended: true, status: 'ATTENDED', source_platform: 'un1t_online', ...over,
})

describe('loadUn1tOnlineJourneyLane', () => {
  it('lanes active un1t.online members by their subscription start, not the day the sync first saw them', async () => {
    const db = makeDb({
      locations: location,
      contact_studios: [studio('c-new'), studio('c-old'), studio('c-ended', { membership_status: 'ended' })],
      un1t_subscriptions: [
        sub('c-new', '2026-10-06T09:00:00Z'),   // day 21 — in
        sub('c-old', '2026-03-01T09:00:00Z'),   // long-standing member — out
        sub('c-ended', '2026-10-10T09:00:00Z'), // not an active member — out
      ],
      contacts: [{ id: 'c-new', name: 'New Member' }, { id: 'c-old', name: 'Old' }, { id: 'c-ended', name: 'Ended' }],
      class_bookings: [],
      churn_radar_actions: [],
    })
    const { lane, config } = await loadUn1tOnlineJourneyLane(db, HATCH, NOW)
    expect(config).toEqual({ windowDays: 42, targetClasses: 9 })
    expect(lane.map((r) => r.contactId)).toEqual(['c-new'])
    expect(lane[0]).toMatchObject({ name: 'New Member', joinedAt: '2026-10-06T09:00:00Z', dayIndex: 21 })
  })

  it('joins on the EARLIEST subscription, so a member who changed plan is not new again', async () => {
    const db = makeDb({
      locations: location,
      contact_studios: [studio('c-switch')],
      un1t_subscriptions: [sub('c-switch', '2026-10-20T09:00:00Z'), sub('c-switch', '2026-05-01T09:00:00Z')],
      contacts: [{ id: 'c-switch', name: 'Switcher' }],
      class_bookings: [],
      churn_radar_actions: [],
    })
    const { lane } = await loadUn1tOnlineJourneyLane(db, HATCH, NOW)
    expect(lane).toEqual([])
  })

  it('skips an active member with no subscription row (no join day to pace from)', async () => {
    const db = makeDb({
      locations: location,
      contact_studios: [studio('c-nosub')],
      un1t_subscriptions: [],
      contacts: [{ id: 'c-nosub', name: 'No sub' }],
      class_bookings: [],
      churn_radar_actions: [],
    })
    expect((await loadUn1tOnlineJourneyLane(db, HATCH, NOW)).lane).toEqual([])
  })

  it('counts attended un1t.online classes at the studio, in window only', async () => {
    const db = makeDb({
      locations: location,
      contact_studios: [studio('c-1')],
      un1t_subscriptions: [sub('c-1', '2026-10-06T09:00:00Z')],
      contacts: [{ id: 'c-1', name: 'One' }],
      class_bookings: [
        booking('c-1', '2026-10-07T07:00:00Z'),
        booking('c-1', '2026-10-09T07:00:00Z'),
        booking('c-1', '2026-10-01T07:00:00Z'),                              // before joining
        booking('c-1', '2026-10-12T07:00:00Z', { attended: false, status: 'NO_SHOW' }),
        booking('c-1', '2026-10-14T07:00:00Z', { status: 'CANCELLED' }),
        booking('c-1', '2026-10-15T07:00:00Z', { location_id: OTHER }),     // another studio
        booking('c-1', '2026-10-16T07:00:00Z', { source_platform: 'glofox' }),
      ],
      churn_radar_actions: [],
    })
    const { lane } = await loadUn1tOnlineJourneyLane(db, HATCH, NOW)
    expect(lane[0].attended).toBe(2)
    const bookingQuery = db.queries.find((q) => q.table === 'class_bookings')
    expect(bookingQuery.calls).toContainEqual(['eq', 'source_platform', 'un1t_online'])
  })

  it('reads only this studio\'s membership facts and subscriptions', async () => {
    const db = makeDb({
      locations: location,
      contact_studios: [studio('c-elsewhere', { location_id: OTHER })],
      un1t_subscriptions: [sub('c-elsewhere', '2026-10-06T09:00:00Z', { location_id: OTHER })],
      contacts: [{ id: 'c-elsewhere', name: 'Elsewhere' }],
      class_bookings: [],
      churn_radar_actions: [],
    })
    expect((await loadUn1tOnlineJourneyLane(db, HATCH, NOW)).lane).toEqual([])
  })

  it('overlays the latest coach touch and sorts worst-first', async () => {
    const db = makeDb({
      locations: location,
      contact_studios: [studio('c-ok'), studio('c-risk')],
      un1t_subscriptions: [sub('c-ok', '2026-10-20T09:00:00Z'), sub('c-risk', '2026-09-22T09:00:00Z')],
      contacts: [{ id: 'c-ok', name: 'OK' }, { id: 'c-risk', name: 'Risk' }],
      class_bookings: [booking('c-ok', '2026-10-21T07:00:00Z')],
      churn_radar_actions: [
        { contact_id: 'c-risk', location_id: HATCH, action: 'contacted', created_at: '2026-10-25T10:00:00Z' },
      ],
    })
    const { lane } = await loadUn1tOnlineJourneyLane(db, HATCH, NOW)
    expect(lane.map((r) => r.contactId)).toEqual(['c-risk', 'c-ok'])
    expect(lane[0].lastTouch).toEqual({ action: 'contacted', at: '2026-10-25T10:00:00Z' })
    expect(lane[1].lastTouch).toBeNull()
  })

  it('throws when a read fails (the route turns it into a 500)', async () => {
    for (const table of ['contact_studios', 'un1t_subscriptions', 'contacts', 'class_bookings']) {
      const db = makeDb({
        locations: location,
        contact_studios: [studio('c-1')],
        un1t_subscriptions: [sub('c-1', '2026-10-06T09:00:00Z')],
        contacts: [{ id: 'c-1', name: 'One' }],
        class_bookings: [],
        churn_radar_actions: [],
        [table]: { __error: `${table} down` },
      })
      await expect(loadUn1tOnlineJourneyLane(db, HATCH, NOW), table).rejects.toThrow(`${table} down`)
    }
  })
})
