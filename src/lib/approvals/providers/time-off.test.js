// LEAVE.2 — the time-off approvals queue: person-scoped (filed here OR a
// member here), expired requests excluded, clash count as the warning.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { timeOffProvider } from './time-off.js'
import { fakeDb, queriesOf } from '../../time-off.test-helpers.js'

const USER = { id: 'hc', activeLocation: { id: 'loc-1' } }

function db({ rows = [], count = 0, assignments = [] } = {}) {
  return fakeDb((q) => {
    if (q.table === 'profile_locations') return { data: [{ profile_id: 'p1' }, { profile_id: 'p2' }], error: null }
    if (q.table === 'shift_assignments') return { data: assignments, error: null }
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
        { id: 'r1', profile_id: 'p1', type: 'unpaid', status: 'pending', start_date: '2026-09-20', end_date: '2026-09-21', total_days: 2, profile: { full_name: 'A' }, location: { name: 'Hatch' } },
        { id: 'r2', profile_id: 'p2', type: 'other', status: 'pending', start_date: '2026-09-22', end_date: '2026-09-22', total_days: 1, profile: { full_name: 'B' } },
      ],
      assignments: [{ id: 'a', profile_id: 'p1', status: 'scheduled', shift_blocks: { block_date: '2026-09-21' } }],
    })
    const { items } = await timeOffProvider.fetchPending(d, USER)
    const main = queriesOf(d, 'time_off_requests')[0]
    expect(main.calls).toContainEqual(['or', 'location_id.in.(loc-1),profile_id.in.(p1,p2)'])
    expect(main.calls).toContainEqual(['eq', 'status', 'pending'])
    expect(main.calls).toContainEqual(['gte', 'end_date', '2026-09-17'])
    expect(items[0]).toMatchObject({ subtitle: expect.stringMatching(/^Unpaid leave/), warning: 'Clashes with 1 rostered shift', clashCount: 1, meta: 'Hatch' })
    expect(items[1]).toMatchObject({ subtitle: expect.stringMatching(/^Other leave/), warning: null, clashCount: 0 })
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
