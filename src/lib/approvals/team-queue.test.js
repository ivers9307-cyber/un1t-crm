import { describe, it, expect } from 'vitest'
import { buildTeamQueue, filterTeamQueue } from './team-queue'

const prov = (key, extra = {}) => ({ key, label: `L-${key}`, reviewBase: '/x', count: 0, items: [], ...extra })
const ids = (arr) => arr.map((i) => i.id)

describe('team queue', () => {
  it('leaves customer providers out and tags every item with its provider key and label', () => {
    const q = buildTeamQueue([
      prov('agent_requests', { count: 1, items: [{ id: 'm' }] }),
      prov('time_off', { count: 1, items: [{ id: 't' }] }),
    ])
    expect(q.items).toEqual([{ id: 't', providerKey: 'time_off', providerLabel: 'L-time_off' }])
  })

  it('orders oldest submitted first, a missing submittedAt last, ties in provider order', () => {
    const q = buildTeamQueue([
      prov('fte_expenses', { items: [{ id: 'e-none' }, { id: 'e-new', submittedAt: '2026-11-12T10:00:00Z' }] }),
      prov('time_off', { items: [{ id: 't-old', submittedAt: '2026-11-01T10:00:00Z' }, { id: 't-tie', submittedAt: '2026-11-12T10:00:00Z' }] }),
      prov('shift_swaps', { items: [{ id: 's-bad', submittedAt: 'nonsense' }] }),
    ])
    expect(ids(q.items)).toEqual(['t-old', 'e-new', 't-tie', 'e-none', 's-bad'])
  })

  it('makes one chip per team provider present, in response order, with the provider count; total sums them', () => {
    const q = buildTeamQueue([
      prov('time_off', { count: 3, items: [{ id: 'a' }] }),
      prov('agent_requests', { count: 9 }),
      prov('rosters', { count: 0 }),
      prov('issues', { count: '2' }),
    ])
    expect(q.chips).toEqual([
      { key: 'time_off', label: 'L-time_off', count: 3 },
      { key: 'rosters', label: 'L-rosters', count: 0 },
      { key: 'issues', label: 'L-issues', count: 2 },
    ])
    expect(q.total).toBe(5)
  })

  it('does not mutate its input and tolerates missing arrays', () => {
    const providers = [prov('time_off', { count: 1, items: [{ id: 'a', submittedAt: '2026-11-01' }] }), { key: 'issues', label: 'I' }]
    const copy = JSON.parse(JSON.stringify(providers))
    const q = buildTeamQueue(providers)
    expect(providers).toEqual(copy)
    expect(ids(q.items)).toEqual(['a'])
    expect(buildTeamQueue(undefined)).toEqual({ items: [], chips: [], total: 0 })
    expect(buildTeamQueue(null).total).toBe(0)
  })

  it('filterTeamQueue narrows by provider key and All returns everything', () => {
    const q = buildTeamQueue([
      prov('time_off', { items: [{ id: 't' }] }),
      prov('issues', { items: [{ id: 'i' }] }),
    ])
    expect(ids(filterTeamQueue(q, 'issues'))).toEqual(['i'])
    expect(ids(filterTeamQueue(q, 'all'))).toEqual(['t', 'i'])
    expect(ids(filterTeamQueue(q, undefined))).toEqual(['t', 'i'])
    expect(filterTeamQueue(null, 'all')).toEqual([])
  })
})
