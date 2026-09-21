// LEAVECANCEL.1 — the "Leave cancellations" approvals queue: open requests to
// cancel APPROVED leave, shown and counted ONLY for the people who can decide
// them (an owner at the active studio, or a master). A manager who sees
// ordinary leave approvals must never be shown one: the decision route would
// refuse them.

import { describe, it, expect, vi, afterEach } from 'vitest'
// The registry FIRST, as every real caller does. Providers import helpers from
// '../registry' and the registry imports the providers; entering that cycle
// through a provider leaves the registry's list holding `undefined` for it.
import { APPROVALS_PROVIDERS, getPendingApprovals, getPendingApprovalsCount } from '../registry.js'
import { timeOffCancellationsProvider } from './time-off-cancellations.js'
import { fakeDb, queriesOf } from '../../time-off.test-helpers.js'

const at = (id, role, profileRole = 'staff', features = {}) => ({
  id, role, profileRole, activeLocation: { id: 'loc-1', features },
  locations: [{ id: 'loc-1', role, features }],
  rolesByLocation: profileRole === 'master' ? {} : { 'loc-1': role },
  assignmentsByLocation: { 'loc-1': { role, permissions: {} } },
})
const OWNER = at('own', 'owner')
const MANAGER = at('mgr-2', 'manager')
const HEAD_COACH = at('hc', 'head_coach')
const MASTER = at('boss', 'master', 'master')

const ROW = {
  id: 'r1', profile_id: 'mgr', location_id: 'loc-1', type: 'holiday', status: 'approved',
  start_date: '2026-10-05', end_date: '2026-10-07', total_days: 3,
  cancel_requested_at: '2026-09-20T09:00:00Z', cancel_request_note: 'Trip fell through',
  profile: { id: 'mgr', full_name: 'Mia Manager' }, location: { id: 'loc-1', name: 'Hatch' },
}

function db({ rows = [ROW], count = rows.length, members = ['mgr', 'own'] } = {}) {
  return fakeDb((q) => {
    if (q.table === 'profile_locations') return { data: members.map((profile_id) => ({ profile_id, location_id: 'loc-1' })), error: null }
    if (q.table === 'time_off_requests') return { data: rows, count, error: null }
    // Every other provider in the registry: nothing pending.
    return { data: [], count: 0, error: null }
  })
}

function freeze() {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-09-21T10:00:00Z'))
}
afterEach(() => vi.useRealTimers())

describe('timeOffCancellationsProvider', () => {
  it('is registered, under its OWN key: the phone renders `time_off` items with approve/decline wired to the status PUT, and must never be handed one of these', () => {
    expect(APPROVALS_PROVIDERS).toContain(timeOffCancellationsProvider)
    expect(timeOffCancellationsProvider.key).toBe('time_off_cancellations')
    expect(timeOffCancellationsProvider.permissionKey).toBeUndefined()
  })

  it('isVisible: an owner at the ACTIVE studio or a master; never a manager, head coach, or an owner of some other studio', () => {
    expect(timeOffCancellationsProvider.isVisible(OWNER)).toBe(true)
    expect(timeOffCancellationsProvider.isVisible(MASTER)).toBe(true)
    expect(timeOffCancellationsProvider.isVisible(MANAGER)).toBe(false)
    expect(timeOffCancellationsProvider.isVisible(HEAD_COACH)).toBe(false)
    const ownerElsewhere = { ...at('o2', 'manager'), rolesByLocation: { 'loc-1': 'manager', 'loc-2': 'owner' } }
    expect(timeOffCancellationsProvider.isVisible(ownerElsewhere)).toBe(false)
    expect(timeOffCancellationsProvider.isVisible(null)).toBe(false)
  })

  it('fetchPending: OPEN asks only (approved, asked, undecided, not ended), person-scoped like the leave queue', async () => {
    freeze()
    const d = db()
    const { count, items } = await timeOffCancellationsProvider.fetchPending(d, OWNER)
    const main = queriesOf(d, 'time_off_requests')[0]
    expect(main.calls).toContainEqual(['or', 'location_id.in.(loc-1),profile_id.in.(mgr,own)'])
    expect(main.calls).toContainEqual(['eq', 'status', 'approved'])
    expect(main.calls).toContainEqual(['not', 'cancel_requested_at', 'is', null])
    expect(main.calls).toContainEqual(['is', 'cancel_decided_at', null])
    expect(main.calls).toContainEqual(['gte', 'end_date', '2026-09-21'])
    expect(count).toBe(1)
    expect(items[0]).toMatchObject({
      id: 'r1', title: 'Mia Manager', meta: 'Hatch', submittedAt: '2026-09-20T09:00:00Z',
      reviewUrl: '/schedule/time-off?focus=r1&view=cancellations',
    })
    expect(items[0].subtitle).toMatch(/^Cancel approved leave · Holiday · 2026-10-05 → 2026-10-07 \(3 days\)/)
    expect(items[0].subtitle).toMatch(/Trip fell through/)
  })

  it('never offers the viewer their OWN ask: they cannot decide it', async () => {
    freeze()
    const d = db()
    const asker = at('mgr', 'owner')
    await timeOffCancellationsProvider.fetchPending(d, asker)
    expect(queriesOf(d, 'time_off_requests')[0].calls).toContainEqual(['neq', 'profile_id', 'mgr'])
    await timeOffCancellationsProvider.countPending(d, asker)
    expect(queriesOf(d, 'time_off_requests')[1].calls).toContainEqual(['neq', 'profile_id', 'mgr'])
  })

  it('countPending uses the same predicate', async () => {
    freeze()
    const d = db({ count: 2 })
    expect(await timeOffCancellationsProvider.countPending(d, OWNER)).toBe(2)
    const main = queriesOf(d, 'time_off_requests')[0]
    expect(main.calls).toContainEqual(['eq', 'status', 'approved'])
    expect(main.calls).toContainEqual(['not', 'cancel_requested_at', 'is', null])
    expect(main.calls).toContainEqual(['is', 'cancel_decided_at', null])
    expect(main.calls).toContainEqual(['gte', 'end_date', '2026-09-21'])
  })

  it('a role that cannot decide gets nothing even if the provider is called directly', async () => {
    const d = db()
    expect(await timeOffCancellationsProvider.fetchPending(d, MANAGER)).toEqual({ count: 0, items: [] })
    expect(await timeOffCancellationsProvider.countPending(d, MANAGER)).toBe(0)
    expect(queriesOf(d, 'time_off_requests')).toHaveLength(0)
  })
})

describe('through the registry: the tab and the badge agree, per role', () => {
  const keysFor = async (user) => (await getPendingApprovals(db(), user)).providers.map((p) => p.key)

  it('owner and master get the tab; manager and head coach do not, though they still get ordinary time off', async () => {
    freeze()
    expect(await keysFor(OWNER)).toContain('time_off_cancellations')
    expect(await keysFor(MASTER)).toContain('time_off_cancellations')
    for (const user of [MANAGER, HEAD_COACH]) {
      const keys = await keysFor(user)
      expect(keys).not.toContain('time_off_cancellations')
      expect(keys).toContain('time_off')
    }
  })

  it('the badge counts it for an owner and not for a manager', async () => {
    freeze()
    const only = (user) => {
      const d = fakeDb((q) => {
        if (q.table === 'profile_locations') return { data: [{ profile_id: 'mgr', location_id: 'loc-1' }], error: null }
        // Only an OPEN-ASK read is answered with a row; ordinary pending leave is empty.
        const openAsk = q.table === 'time_off_requests' && q.calls.some(([op, col]) => op === 'not' && col === 'cancel_requested_at')
        return { data: [], count: openAsk ? 1 : 0, error: null }
      })
      return getPendingApprovalsCount(d, user)
    }
    expect(await only(OWNER)).toBe(1)
    expect(await only(MANAGER)).toBe(0)
  })

  it('follows bundle_team like the rest of the scheduling reviews', async () => {
    freeze()
    expect(await keysFor(at('own', 'owner', 'staff', { bundle_team: false }))).not.toContain('time_off_cancellations')
  })
})
