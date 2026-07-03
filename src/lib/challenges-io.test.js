import { describe, it, expect } from 'vitest'
import { computeStandings, computeCollective, countsAsAttendance } from './challenges-io.js'

function fakeDb(rows) {
  const q = {
    select: () => q, eq: () => q, not: () => q, gte: () => q, lt: () => q,
    order: () => q, range: async () => ({ data: rows, error: null }),
  }
  return { from: () => q }
}
const rows = [
  { contact_id: 'a', effort_points: 300, zones_seconds: {}, contacts: { name: 'Sarah Kelly' } },
  { contact_id: 'a', effort_points: 200, zones_seconds: {}, contacts: { name: 'Sarah Kelly' } },
  { contact_id: 'b', effort_points: 450, zones_seconds: {}, contacts: { name: 'Mike Doyle' } },
]

describe('computeStandings', () => {
  it('aggregates points per contact, ranked, projected', async () => {
    const out = await computeStandings(fakeDb(rows), { locationId: 'L', metric: 'points', fromIso: 'x', toIso: 'y' })
    expect(out.map((r) => [r.name, r.value, r.rank])).toEqual([['Sarah K.', 500, 1], ['Mike D.', 450, 2]])
  })
})
describe('computeCollective', () => {
  it('sums all + pct', async () => {
    const out = await computeCollective(fakeDb(rows), { locationId: 'L', metric: 'points', fromIso: 'x', toIso: 'y', target: 1000 })
    expect(out).toEqual({ total: 950, target: 1000, pct: 0.95 })
  })
})

// Attendance rule (Richard, 2026-07-03 / mig 347): "classes" counts a session
// ONLY if it is class-linked (glofox_event_id set) AND device-backed
// (source is NOT 'participation'/'manual'). Points stay fully inclusive.
const CONTACT = { name: 'Ava Long' }
const strapClass = { contact_id: 'x', source: 'ble_bridge', glofox_event_id: 'e1', effort_points: 100, zones_seconds: {}, contacts: CONTACT }
const mappedWearableClass = { contact_id: 'x', source: 'apple_health', glofox_event_id: 'e2', effort_points: 120, zones_seconds: {}, contacts: CONTACT }
const offsiteWearable = { contact_id: 'x', source: 'apple_health', glofox_event_id: null, effort_points: 80, zones_seconds: {}, contacts: CONTACT }
const noDeviceParticipation = { contact_id: 'x', source: 'participation', glofox_event_id: 'e3', effort_points: 10, zones_seconds: {}, contacts: CONTACT }

describe('countsAsAttendance', () => {
  it('in-studio strap class session counts', () => {
    expect(countsAsAttendance(strapClass)).toBe(true)
  })
  it('auto-mapped wearable class session counts', () => {
    expect(countsAsAttendance(mappedWearableClass)).toBe(true)
  })
  it('outside-studio wearable session (no glofox_event_id) does NOT count', () => {
    expect(countsAsAttendance(offsiteWearable)).toBe(false)
  })
  it('no-device participation credit (has glofox_event_id) does NOT count', () => {
    expect(countsAsAttendance(noDeviceParticipation)).toBe(false)
    expect(countsAsAttendance({ ...noDeviceParticipation, source: 'manual' })).toBe(false)
  })
})

describe('computeStandings classes metric (attendance rule)', () => {
  it('counts only class-linked + device-backed sessions', async () => {
    const db = fakeDb([strapClass, mappedWearableClass, offsiteWearable, noDeviceParticipation])
    const out = await computeStandings(db, { locationId: 'L', metric: 'classes', fromIso: 'x', toIso: 'y' })
    // 2 qualifying (strap class + auto-mapped wearable class); off-site + participation excluded.
    expect(out).toEqual([{ contactId: 'x', value: 2, name: 'Ava L.', rank: 1 }])
  })

  it('an outside-studio wearable does NOT increment classes but DOES add points', async () => {
    const db = fakeDb([offsiteWearable])
    const classesOut = await computeStandings(db, { locationId: 'L', metric: 'classes', fromIso: 'x', toIso: 'y' })
    expect(classesOut).toEqual([{ contactId: 'x', value: 0, name: 'Ava L.', rank: 1 }])
    const pointsOut = await computeStandings(db, { locationId: 'L', metric: 'points', fromIso: 'x', toIso: 'y' })
    expect(pointsOut).toEqual([{ contactId: 'x', value: 80, name: 'Ava L.', rank: 1 }])
  })
})

describe('computeCollective classes metric (attendance rule)', () => {
  it('collective classes count applies the same class-linked + device-backed rule', async () => {
    const db = fakeDb([strapClass, mappedWearableClass, offsiteWearable, noDeviceParticipation])
    const out = await computeCollective(db, { locationId: 'L', metric: 'classes', fromIso: 'x', toIso: 'y', target: 4 })
    expect(out).toEqual({ total: 2, target: 4, pct: 0.5 })
  })
})

// DECISION #1 (mig 348) — the PUBLIC challenge board passes excludeOptedOut:true
// to hide members who opted out of the leaderboard. Their sessions still score
// for THEM (the winner-announcing cron omits the flag → default false), so this
// affects only the public render.
describe('computeStandings leaderboard opt-out', () => {
  const shown = { contact_id: 'a', effort_points: 500, zones_seconds: {}, contacts: { name: 'Sarah Kelly', hr_leaderboard_opt_out: false } }
  const optedOut = { contact_id: 'b', effort_points: 900, zones_seconds: {}, contacts: { name: 'Mike Doyle', hr_leaderboard_opt_out: true } }

  it('excludes opted-out members from the PUBLIC standings but keeps their data by default', async () => {
    // Default (cron path): both members present — the opted-out member still
    // scores and would still be the winner.
    const included = await computeStandings(fakeDb([shown, optedOut]), { locationId: 'L', metric: 'points', fromIso: 'x', toIso: 'y' })
    expect(included.map((r) => r.name)).toEqual(['Mike D.', 'Sarah K.'])

    // Public path: opted-out member dropped from the rendered board.
    const publicOut = await computeStandings(fakeDb([shown, optedOut]), { locationId: 'L', metric: 'points', fromIso: 'x', toIso: 'y', excludeOptedOut: true })
    expect(publicOut.map((r) => r.name)).toEqual(['Sarah K.'])
  })

  it('opt-out also drops the member from the collective total on the public board', async () => {
    const included = await computeCollective(fakeDb([shown, optedOut]), { locationId: 'L', metric: 'points', fromIso: 'x', toIso: 'y', target: 2000 })
    expect(included.total).toBe(1400)
    const publicOut = await computeCollective(fakeDb([shown, optedOut]), { locationId: 'L', metric: 'points', fromIso: 'x', toIso: 'y', target: 2000, excludeOptedOut: true })
    expect(publicOut.total).toBe(500)
  })
})
