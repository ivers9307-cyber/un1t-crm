// LEAVE.2 — the time-off approvals queue: person-scoped (filed here OR a
// member here), expired requests excluded, clash count as the warning.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { timeOffProvider } from './time-off.js'
import { fakeDb, queriesOf, resolveLocations, scopedAssignments, locationScopeOf } from '../../time-off.test-helpers.js'

// A head coach at loc-1: holds time-off approval there by default, which is
// what gets them into this queue at all (the registry's permission check).
const USER = {
  id: 'hc', role: 'head_coach', profileRole: 'staff', activeLocation: { id: 'loc-1' },
  locations: [{ id: 'loc-1', role: 'head_coach', features: {} }],
  assignmentsByLocation: { 'loc-1': { role: 'head_coach', permissions: {} } },
}

// ORGSCOPE.2 — loc-1 + loc-2 are one organisation; loc-x is another's studio.
// `memberships` answers both profile_locations reads (who is here; where each
// requester belongs), and the shift read honours its location filter.
const ORGS = { 'loc-1': 'org-1', 'loc-2': 'org-1', 'loc-x': 'org-x' }

function db({ rows = [], count = 0, assignments = [], memberships = { p1: ['loc-1'], p2: ['loc-1'] } } = {}) {
  return fakeDb((q) => {
    if (q.table === 'profile_locations') {
      return { data: Object.entries(memberships).flatMap(([profile_id, locs]) => locs.map((location_id) => ({ profile_id, location_id }))), error: null }
    }
    if (q.table === 'locations') return resolveLocations(q, ORGS)
    if (q.table === 'shift_assignments') return scopedAssignments(q, assignments)
    if (q.table === 'time_off_requests') return { data: rows, count, error: null }
    throw new Error(q.table)
  })
}

afterEach(() => vi.useRealTimers())

describe('timeOffProvider', () => {
  it('fetchPending: scoped by person, excludes expired, labels every type, carries the clash warning', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-17T10:00:00Z'))
    const d = db({
      rows: [
        { id: 'r1', profile_id: 'p1', location_id: 'loc-1', type: 'unpaid', status: 'pending', start_date: '2026-09-20', end_date: '2026-09-21', total_days: 2, profile: { full_name: 'A' }, location: { name: 'Hatch' } },
        { id: 'r2', profile_id: 'p2', location_id: 'loc-1', type: 'other', status: 'pending', start_date: '2026-09-22', end_date: '2026-09-22', total_days: 1, profile: { full_name: 'B' } },
      ],
      assignments: [{ id: 'a', profile_id: 'p1', status: 'scheduled', shift_blocks: { block_date: '2026-09-21', location_id: 'loc-1' } }],
    })
    const { items } = await timeOffProvider.fetchPending(d, USER)
    const main = queriesOf(d, 'time_off_requests')[0]
    expect(main.calls).toContainEqual(['or', 'location_id.in.(loc-1),profile_id.in.(p1,p2)'])
    expect(main.calls).toContainEqual(['eq', 'status', 'pending'])
    expect(main.calls).toContainEqual(['gte', 'end_date', '2026-09-17'])
    expect(items[0]).toMatchObject({ subtitle: expect.stringMatching(/^Unpaid leave/), warning: 'Clashes with 1 rostered shift', clashCount: 1, meta: 'Hatch' })
    expect(items[1]).toMatchObject({ subtitle: expect.stringMatching(/^Other leave/), warning: null, clashCount: 0 })
  })

  // ORGSCOPE.2 — p1 is also on staff at loc-x, another organisation's studio.
  it('the clash warning never counts the coach\'s shifts at another organisation\'s studio', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-17T10:00:00Z'))
    const d = db({
      memberships: { p1: ['loc-1', 'loc-x'] },
      rows: [{ id: 'r1', profile_id: 'p1', location_id: 'loc-1', type: 'unpaid', status: 'pending', start_date: '2026-09-20', end_date: '2026-09-21', total_days: 2, profile: { full_name: 'A' } }],
      assignments: [
        { id: 'a', profile_id: 'p1', status: 'scheduled', shift_blocks: { block_date: '2026-09-20', location_id: 'loc-2' } },
        { id: 'x', profile_id: 'p1', status: 'scheduled', shift_blocks: { block_date: '2026-09-21', location_id: 'loc-x' } },
      ],
    })
    const { items } = await timeOffProvider.fetchPending(d, USER)
    expect(items[0]).toMatchObject({ warning: 'Clashes with 1 rostered shift', clashCount: 1 })
    expect(locationScopeOf(queriesOf(d, 'shift_assignments')[0]).sort()).toEqual(['loc-1', 'loc-2'])
  })

  it('countPending uses the same scope and expiry', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-17T10:00:00Z'))
    const d = db({ count: 4 })
    expect(await timeOffProvider.countPending(d, USER)).toBe(4)
    const main = queriesOf(d, 'time_off_requests')[0]
    expect(main.calls).toContainEqual(['or', 'location_id.in.(loc-1),profile_id.in.(p1,p2)'])
    expect(main.calls).toContainEqual(['gte', 'end_date', '2026-09-17'])
  })
})
