import { describe, it, expect } from 'vitest'
import { loadJourneyLane, loadContactJourney } from './onboarding-journey-data'

// PULSE-90.2 — mocked-db tests for the journey data layer. The pace math
// itself is covered exhaustively in onboarding-journey.test.js; these
// exercise what the DATA layer owns:
//   • the joined_at lane cutoff (windowDays + 14 tail)
//   • the per-member attendance window filter (Dublin-day, attended=true,
//     status ≠ CANCELLED, pre-join / post-window rows dropped)
//   • .range() pagination past the 1k cap
//   • worst-first lane ordering + the lastTouch overlay
//   • per-location config override
//   • DB errors throwing to the caller (route turns them into a 500)

// ---------------------------------------------------------------------------
// A chainable Supabase mock that actually APPLIES filters/order/range like
// PostgREST does (same spirit as churn-radar-data.test.js, but generic —
// the window/pagination behaviour under test lives in the filters).
//
// Postgres semantics worth being faithful to:
//   .gte(col, v)         NULL >= v is NULL → row excluded
//   .not(col, 'eq', v)   NOT (NULL = v) is NULL → row excluded
// A table value of { __error: 'msg' } resolves { data: null, error } so
// error paths can be tested.
function makeDb(tables) {
  function builder(table) {
    const filters = []
    const orders = []
    let rangeSpec = null
    let single = false
    const b = {
      select() { return b },
      eq(col, val) { filters.push((r) => r[col] === val); return b },
      in(col, vals) { filters.push((r) => vals.includes(r[col])); return b },
      gte(col, val) { filters.push((r) => r[col] != null && String(r[col]) >= String(val)); return b },
      not(col, op, val) {
        if (op === 'eq') filters.push((r) => r[col] != null && r[col] !== val)
        else if (op === 'is') filters.push((r) => r[col] !== val)
        return b
      },
      order(col, opts = {}) { orders.push({ col, asc: opts.ascending !== false }); return b },
      range(from, to) { rangeSpec = [from, to]; return b },
      limit() { return b },
      maybeSingle() { single = true; return b },
      then(resolve, reject) {
        const src = tables[table]
        if (src && src.__error) {
          return Promise.resolve({ data: null, error: { message: src.__error } }).then(resolve, reject)
        }
        let rows = (Array.isArray(src) ? src : []).filter((r) => filters.every((f) => f(r)))
        // Stable multi-key sort: apply order specs last-to-first.
        for (let i = orders.length - 1; i >= 0; i--) {
          const { col, asc } = orders[i]
          rows = [...rows].sort((a, z) => {
            if (a[col] === z[col]) return 0
            return (a[col] > z[col] ? 1 : -1) * (asc ? 1 : -1)
          })
        }
        if (rangeSpec) rows = rows.slice(rangeSpec[0], rangeSpec[1] + 1)
        const value = single ? { data: rows[0] ?? null, error: null } : { data: rows, error: null }
        return Promise.resolve(value).then(resolve, reject)
      },
    }
    return b
  }
  return { from: (table) => builder(table) }
}

// ---------------------------------------------------------------------------
// Fixtures. June 2026 is IST (Dublin = UTC+1) so late-evening UTC instants
// belong to the NEXT Dublin day — the window-boundary test leans on that.

const LOC = 'loc-1'
const NOW = Date.parse('2026-06-15T12:00:00Z') // Dublin day 2026-06-15

const location = (notification_config = null) => [{ id: LOC, notification_config }]

let contactSeq = 0
function member({ id, name = 'Member', joined_at, location_id = LOC, status = 'member' }) {
  return { id: id || `c-${++contactSeq}`, name, joined_at, location_id, glofox_membership_status: status }
}

let bookingSeq = 0
function booking(contact_id, starts_at, { attended = true, status = 'ATTENDED' } = {}) {
  bookingSeq += 1
  return {
    id: `b-${String(bookingSeq).padStart(5, '0')}`,
    contact_id, location_id: LOC, starts_at, attended, status,
  }
}

describe('loadJourneyLane', () => {
  it('lanes new members, excluding anyone who joined before the windowDays+14 cutoff', async () => {
    const db = makeDb({
      locations: location(),
      contacts: [
        member({ id: 'c-new', joined_at: '2026-05-20T09:00:00Z' }),     // day 26 — in
        member({ id: 'c-old', joined_at: '2026-01-05T09:00:00Z' }),     // ~161 days — out
      ],
      class_bookings: [],
      churn_radar_actions: [],
    })
    const { lane, config } = await loadJourneyLane(db, LOC, NOW)
    expect(config).toEqual({ windowDays: 42, targetClasses: 9 })
    expect(lane.map((r) => r.contactId)).toEqual(['c-new'])
    expect(lane[0].dayIndex).toBe(26)
    expect(lane[0].target).toBe(9)
  })

  it('counts only in-window attended bookings (pre-join, post-window, unattended, cancelled all dropped)', async () => {
    // Eve joined day −51 (expired: dayIndex 51 > 42, inside the +14 tail).
    const db = makeDb({
      locations: location(),
      contacts: [member({ id: 'c-eve', joined_at: '2026-04-25T10:00:00Z' })],
      class_bookings: [
        booking('c-eve', '2026-04-24T18:00:00Z'),                         // pre-join → dropped
        booking('c-eve', '2026-06-04T18:00:00Z'),                         // day 40 → counted
        booking('c-eve', '2026-06-09T18:00:00Z'),                         // day 45 → post-window, dropped
        booking('c-eve', '2026-05-10T18:00:00Z', { attended: false, status: 'BOOKED' }), // not attended
        booking('c-eve', '2026-05-12T18:00:00Z', { status: 'CANCELLED' }), // cancelled
      ],
      churn_radar_actions: [],
    })
    const { lane } = await loadJourneyLane(db, LOC, NOW)
    expect(lane).toHaveLength(1)
    expect(lane[0].attended).toBe(1)
    expect(lane[0].status).toBe('expired')
  })

  it('sorts worst-first: at_risk, behind, on_track, then expired/completed', async () => {
    const joined = '2026-05-20T09:00:00Z' // day 26, expectedByNow = floor(26/42*9) = 5
    const db = makeDb({
      locations: location(),
      contacts: [
        member({ id: 'c-cara', joined_at: joined }),                     // 6 attended → on_track
        member({ id: 'c-eve', joined_at: '2026-04-25T10:00:00Z' }),      // day 51, 1 attended → expired
        member({ id: 'c-alice', joined_at: joined }),                    // 0 attended → at_risk
        member({ id: 'c-bob', joined_at: joined }),                      // 4 attended → behind
      ],
      class_bookings: [
        ...Array.from({ length: 6 }, (_, i) => booking('c-cara', `2026-06-0${i + 1}T18:00:00Z`)),
        ...Array.from({ length: 4 }, (_, i) => booking('c-bob', `2026-06-1${i}T18:00:00Z`)),
        booking('c-eve', '2026-05-10T18:00:00Z'),
      ],
      churn_radar_actions: [],
    })
    const { lane } = await loadJourneyLane(db, LOC, NOW)
    expect(lane.map((r) => `${r.contactId}:${r.status}`)).toEqual([
      'c-alice:at_risk', 'c-bob:behind', 'c-cara:on_track', 'c-eve:expired',
    ])
  })

  it('overlays lastTouch from the latest contacting churn_radar_actions row', async () => {
    const joined = '2026-05-20T09:00:00Z'
    const db = makeDb({
      locations: location(),
      contacts: [
        member({ id: 'c-alice', joined_at: joined }),
        member({ id: 'c-bob', joined_at: joined }),
      ],
      class_bookings: [],
      churn_radar_actions: [
        { contact_id: 'c-alice', location_id: LOC, action: 'winback_sent', created_at: '2026-06-01T10:00:00Z' },
        { contact_id: 'c-alice', location_id: LOC, action: 'contacted', created_at: '2026-06-14T10:00:00Z' },
        // snoozed is not a contacting action — must not surface as a touch
        { contact_id: 'c-bob', location_id: LOC, action: 'snoozed', created_at: '2026-06-14T10:00:00Z' },
      ],
    })
    const { lane } = await loadJourneyLane(db, LOC, NOW)
    const alice = lane.find((r) => r.contactId === 'c-alice')
    const bob = lane.find((r) => r.contactId === 'c-bob')
    expect(alice.lastTouch).toEqual({ action: 'contacted', at: '2026-06-14T10:00:00Z' })
    expect(bob.lastTouch).toBeNull()
  })

  it('honours the per-location config override (window + target + cutoff shrink)', async () => {
    const db = makeDb({
      locations: location({ categories: { onboarding_pace: { window_days: 28, target_classes: 6 } } }),
      contacts: [
        member({ id: 'c-mid', joined_at: '2026-05-10T09:00:00Z' }),      // day 36 > 28 → expired, in 42d tail
        member({ id: 'c-out', joined_at: '2026-04-25T10:00:00Z' }),      // day 51 > 28+14 → excluded
      ],
      class_bookings: [],
      churn_radar_actions: [],
    })
    const { lane, config } = await loadJourneyLane(db, LOC, NOW)
    expect(config).toEqual({ windowDays: 28, targetClasses: 6 })
    expect(lane.map((r) => r.contactId)).toEqual(['c-mid'])
    expect(lane[0].status).toBe('expired')
    expect(lane[0].target).toBe(6)
  })

  it('paginates the member select past the 1k cap', async () => {
    const contacts = Array.from({ length: 1050 }, (_, i) =>
      member({ id: `c-${String(i).padStart(4, '0')}`, joined_at: '2026-06-10T09:00:00Z' }))
    const db = makeDb({
      locations: location(),
      contacts,
      class_bookings: [],
      churn_radar_actions: [],
    })
    const { lane } = await loadJourneyLane(db, LOC, NOW)
    expect(lane).toHaveLength(1050)
  })

  it('ignores non-member statuses (lead / ex_member never lane)', async () => {
    const db = makeDb({
      locations: location(),
      contacts: [
        member({ id: 'c-member', joined_at: '2026-05-20T09:00:00Z' }),
        member({ id: 'c-lead', joined_at: '2026-05-20T09:00:00Z', status: 'lead' }),
        member({ id: 'c-ex', joined_at: '2026-05-20T09:00:00Z', status: 'ex_member' }),
      ],
      class_bookings: [],
      churn_radar_actions: [],
    })
    const { lane } = await loadJourneyLane(db, LOC, NOW)
    expect(lane.map((r) => r.contactId)).toEqual(['c-member'])
  })

  it('throws on a members DB error (route turns it into a 500)', async () => {
    const db = makeDb({
      locations: location(),
      contacts: { __error: 'boom' },
      class_bookings: [],
      churn_radar_actions: [],
    })
    await expect(loadJourneyLane(db, LOC, NOW)).rejects.toThrow('boom')
  })

  it('still lanes (without touches) when the actions read fails — touch overlay is best-effort', async () => {
    const db = makeDb({
      locations: location(),
      contacts: [member({ id: 'c-new', joined_at: '2026-05-20T09:00:00Z' })],
      class_bookings: [],
      churn_radar_actions: { __error: 'boom' },
    })
    const { lane } = await loadJourneyLane(db, LOC, NOW)
    expect(lane).toHaveLength(1)
    expect(lane[0].lastTouch).toBeNull()
  })
})

describe('loadContactJourney', () => {
  it('returns the journey row for an in-window member, attendance window-filtered', async () => {
    const db = makeDb({
      locations: location(),
      contacts: [member({ id: 'c-zoe', name: 'Zoe', joined_at: '2026-05-20T09:00:00Z' })],
      class_bookings: [
        booking('c-zoe', '2026-05-19T18:00:00Z'),                        // pre-join → dropped
        booking('c-zoe', '2026-05-25T18:00:00Z'),
        booking('c-zoe', '2026-06-01T18:00:00Z'),
        booking('c-zoe', '2026-06-08T18:00:00Z'),
        booking('c-zoe', '2026-06-13T18:00:00Z'),
        booking('c-zoe', '2026-06-02T18:00:00Z', { status: 'CANCELLED' }), // dropped
      ],
      churn_radar_actions: [],
    })
    const row = await loadContactJourney(db, 'c-zoe', NOW)
    expect(row).toMatchObject({
      contactId: 'c-zoe', name: 'Zoe', joinedAt: '2026-05-20T09:00:00Z',
      inWindow: true, dayIndex: 26, attended: 4, target: 9, status: 'behind',
    })
  })

  it('returns null for a missing contact', async () => {
    const db = makeDb({ locations: location(), contacts: [], class_bookings: [] })
    expect(await loadContactJourney(db, 'c-ghost', NOW)).toBeNull()
  })

  it('returns null when the contact has no joined_at', async () => {
    const db = makeDb({
      locations: location(),
      contacts: [member({ id: 'c-nojoin', joined_at: null })],
      class_bookings: [],
    })
    expect(await loadContactJourney(db, 'c-nojoin', NOW)).toBeNull()
  })

  it('returns null once the window has expired without completion', async () => {
    const db = makeDb({
      locations: location(),
      contacts: [member({ id: 'c-eve', joined_at: '2026-04-25T10:00:00Z' })], // day 51
      class_bookings: [booking('c-eve', '2026-05-10T18:00:00Z')],
      churn_radar_actions: [],
    })
    expect(await loadContactJourney(db, 'c-eve', NOW)).toBeNull()
  })

  it('still returns a completed journey just past the window (celebration tail)', async () => {
    const db = makeDb({
      locations: location(),
      contacts: [member({ id: 'c-fin', joined_at: '2026-04-28T10:00:00Z' })], // day 48
      class_bookings: Array.from({ length: 9 }, (_, i) =>
        booking('c-fin', `2026-05-${String(i + 2).padStart(2, '0')}T18:00:00Z`)),
      churn_radar_actions: [],
    })
    const row = await loadContactJourney(db, 'c-fin', NOW)
    expect(row).toMatchObject({ status: 'completed', inWindow: false, attended: 9 })
  })

  it('returns null beyond the windowDays+14 tail, even for a finisher', async () => {
    const db = makeDb({
      locations: location(),
      contacts: [member({ id: 'c-vet', joined_at: '2026-04-10T10:00:00Z' })], // day 66
      class_bookings: Array.from({ length: 9 }, (_, i) =>
        booking('c-vet', `2026-04-${String(i + 11).padStart(2, '0')}T18:00:00Z`)),
      churn_radar_actions: [],
    })
    expect(await loadContactJourney(db, 'c-vet', NOW)).toBeNull()
  })

  it('buckets the window boundary by Dublin day, not UTC day', async () => {
    // Joined Dublin day 2026-05-01 → last in-window Dublin day (42) is 2026-06-12.
    // June is IST: 23:30 UTC on the 12th is 00:30 on the 13th in Dublin → day 43, OUT.
    const now = Date.parse('2026-06-12T22:00:00Z')
    const db = makeDb({
      locations: location(),
      contacts: [member({ id: 'c-edge', joined_at: '2026-05-01T10:00:00Z' })],
      class_bookings: [
        booking('c-edge', '2026-05-15T18:00:00Z'),   // mid-window → counted
        booking('c-edge', '2026-06-12T21:30:00Z'),   // 22:30 Dublin, day 42 → counted
        booking('c-edge', '2026-06-12T23:30:00Z'),   // 00:30 Dublin on the 13th, day 43 → dropped
      ],
      churn_radar_actions: [],
    })
    const row = await loadContactJourney(db, 'c-edge', now)
    expect(row.attended).toBe(2)
    expect(row.inWindow).toBe(true)
  })

  it('throws on a contact DB error (route turns it into a 500)', async () => {
    const db = makeDb({ locations: location(), contacts: { __error: 'boom' }, class_bookings: [] })
    await expect(loadContactJourney(db, 'c-any', NOW)).rejects.toThrow('boom')
  })
})
