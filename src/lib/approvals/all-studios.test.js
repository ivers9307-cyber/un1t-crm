// APPROVALSQ.6 — the "all my studios" list is the union of the per-studio lists.
import { describe, it, expect, vi } from 'vitest'
import { getPendingApprovalsAllStudios, listEligibleStudios } from './all-studios.js'

const S1 = { id: 's1', name: 'Zed Studio' }
const S2 = { id: 's2', name: 'Alpha Studio' }
const S3 = { id: 's3', name: 'Middle Studio' }

// A user whose derived copy remembers the studio it was derived for.
function makeUser({ locations, active, noInbox = [] }) {
  return { id: 'u1', locations, activeLocation: locations.find((l) => l.id === active) || locations[0], noInbox }
}
const deps = (over = {}) => ({
  userAtLocation: (user, id) => {
    const loc = user.locations.find((l) => l.id === id)
    return loc ? { ...user, activeLocation: loc } : null
  },
  hasPermission: (u, key) => key === 'approvals_inbox' && !u.noInbox.includes(u.activeLocation.id),
  getPendingApprovals: vi.fn(async () => ({ providers: [], total: 0 })),
  ...over,
})
const prov = (key, items = [], failedItems = [], extra = {}) => ({
  key, label: `L ${key}`, reviewBase: `/${key}`, count: items.length + failedItems.length, items, failedItems, ...extra,
})
const resultFor = (map) => vi.fn(async (_db, u) => map[u.activeLocation.id] ?? { providers: [], total: 0 })

describe('listEligibleStudios', () => {
  it('keeps only studios whose derived user holds approvals_inbox, active first then by name', () => {
    const user = makeUser({ locations: [S1, S2, S3], active: 's3', noInbox: ['s2'] })
    const r = listEligibleStudios(user, {}, deps())
    expect(r.studios).toEqual([{ id: 's3', name: 'Middle Studio' }, { id: 's1', name: 'Zed Studio' }])
    expect(r.truncated).toBe(false)
  })

  it('orders the rest by name when the active studio is not eligible', () => {
    const user = makeUser({ locations: [S1, S2, S3], active: 's3', noInbox: ['s3'] })
    expect(listEligibleStudios(user, {}, deps()).studios.map((s) => s.id)).toEqual(['s2', 's1'])
  })

  it('caps at maxStudios and flags truncated', () => {
    const locs = Array.from({ length: 5 }, (_, i) => ({ id: `x${i}`, name: `Studio ${i}` }))
    const user = makeUser({ locations: locs, active: 'x4' })
    const r = listEligibleStudios(user, { maxStudios: 3 }, deps())
    expect(r.studios.map((s) => s.id)).toEqual(['x4', 'x0', 'x1'])
    expect(r.truncated).toBe(true)
    expect(listEligibleStudios(user, { maxStudios: 5 }, deps()).truncated).toBe(false)
  })

  it('defaults the cap to 12', () => {
    const locs = Array.from({ length: 14 }, (_, i) => ({ id: `x${String(i).padStart(2, '0')}`, name: `Studio ${String(i).padStart(2, '0')}` }))
    const r = listEligibleStudios(makeUser({ locations: locs, active: 'x00' }), {}, deps())
    expect(r.studios).toHaveLength(12)
    expect(r.truncated).toBe(true)
  })
})

describe('getPendingApprovalsAllStudios', () => {
  it('with one eligible studio returns that studio\'s result, tagged', async () => {
    const user = makeUser({ locations: [S1], active: 's1' })
    const getPendingApprovals = resultFor({ s1: { providers: [prov('time_off', [{ id: 'a', title: 'A' }])], total: 1 } })
    const r = await getPendingApprovalsAllStudios({}, user, {}, deps({ getPendingApprovals }))
    expect(r.scope).toBe('all')
    expect(r.total).toBe(1)
    expect(r.studios).toEqual([{ id: 's1', name: 'Zed Studio' }])
    expect(r.failedStudios).toEqual([])
    expect(r.truncated).toBe(false)
    expect(r.providers).toEqual([
      { key: 'time_off', label: 'L time_off', reviewBase: '/time_off', count: 1, items: [{ id: 'a', title: 'A', studioId: 's1', studioName: 'Zed Studio' }], failedItems: [] },
    ])
  })

  it('never queries or names a studio whose derived user lacks approvals_inbox', async () => {
    const user = makeUser({ locations: [S1, S2], active: 's1', noInbox: ['s2'] })
    const getPendingApprovals = resultFor({ s1: { providers: [prov('issues', [{ id: 'i' }])], total: 1 } })
    const r = await getPendingApprovalsAllStudios({}, user, {}, deps({ getPendingApprovals }))
    expect(getPendingApprovals).toHaveBeenCalledTimes(1)
    expect(getPendingApprovals.mock.calls[0][1].activeLocation.id).toBe('s1')
    expect(JSON.stringify(r)).not.toContain('Alpha Studio')
    expect(r.studios.map((s) => s.id)).toEqual(['s1'])
  })

  it('passes each studio the derived user, not the original', async () => {
    const user = makeUser({ locations: [S1, S2], active: 's1' })
    const getPendingApprovals = resultFor({})
    await getPendingApprovalsAllStudios('DB', user, {}, deps({ getPendingApprovals }))
    expect(getPendingApprovals.mock.calls.map((c) => [c[0], c[1].activeLocation.id]).sort()).toEqual([['DB', 's1'], ['DB', 's2']])
  })

  it('tags items and failedItems, and orders items active studio first', async () => {
    const user = makeUser({ locations: [S1, S2], active: 's1' })
    const getPendingApprovals = resultFor({
      s1: { providers: [prov('agent_requests', [{ id: 'a' }], [{ id: 'f1' }])], total: 2 },
      s2: { providers: [prov('agent_requests', [{ id: 'b' }], [{ id: 'f2' }])], total: 2 },
    })
    const r = await getPendingApprovalsAllStudios({}, user, {}, deps({ getPendingApprovals }))
    const p = r.providers[0]
    expect(p.items).toEqual([
      { id: 'a', studioId: 's1', studioName: 'Zed Studio' },
      { id: 'b', studioId: 's2', studioName: 'Alpha Studio' },
    ])
    expect(p.failedItems).toEqual([
      { id: 'f1', studioId: 's1', studioName: 'Zed Studio' },
      { id: 'f2', studioId: 's2', studioName: 'Alpha Studio' },
    ])
    expect(p.count).toBe(4)
    expect(r.total).toBe(4)
  })

  it('merges by key, keeps the first label and reviewBase, active studio order first then first-seen', async () => {
    const user = makeUser({ locations: [S1, S2, S3], active: 's1' })
    const getPendingApprovals = resultFor({
      s1: { providers: [prov('b', [{ id: '1' }]), prov('a', [{ id: '2' }], [], { label: 'Active label', reviewBase: '/active' })], total: 2 },
      s2: { providers: [prov('a', [{ id: '3' }], [], { label: 'Other label', reviewBase: '/other' }), prov('c', [{ id: '4' }])], total: 2 },
      s3: { providers: [prov('d', [{ id: '5' }]), prov('c', [{ id: '6' }])], total: 2 },
    })
    const r = await getPendingApprovalsAllStudios({}, user, {}, deps({ getPendingApprovals }))
    expect(r.providers.map((p) => p.key)).toEqual(['b', 'a', 'c', 'd'])
    const a = r.providers.find((p) => p.key === 'a')
    expect(a.label).toBe('Active label')
    expect(a.reviewBase).toBe('/active')
    expect(a.items.map((i) => i.id)).toEqual(['2', '3'])
    expect(r.total).toBe(6)
  })

  it('the same time-off item listed under two studios appears once, under the active studio', async () => {
    const user = makeUser({ locations: [S1, S2], active: 's2' })
    const getPendingApprovals = resultFor({
      s1: { providers: [prov('time_off', [{ id: 'leave-1', title: 'Sam' }])], total: 1 },
      s2: { providers: [prov('time_off', [{ id: 'leave-1', title: 'Sam' }])], total: 1 },
    })
    const r = await getPendingApprovalsAllStudios({}, user, {}, deps({ getPendingApprovals }))
    expect(r.providers[0].items).toEqual([{ id: 'leave-1', title: 'Sam', studioId: 's2', studioName: 'Alpha Studio' }])
    expect(r.providers[0].count).toBe(1)
    expect(r.total).toBe(1)
  })

  it('a host event listed under two studios of one organisation appears once, under the first in studio order when none is active', async () => {
    const user = makeUser({ locations: [S1, S2], active: 'elsewhere' })
    user.activeLocation = { id: 'elsewhere' }
    const getPendingApprovals = resultFor({
      s1: { providers: [prov('host_events', [{ id: 'ev-1' }])], total: 1 },
      s2: { providers: [prov('host_events', [{ id: 'ev-1' }])], total: 1 },
    })
    const r = await getPendingApprovalsAllStudios({}, user, {}, deps({ getPendingApprovals }))
    // Alpha (s2) sorts before Zed (s1)
    expect(r.providers[0].items).toEqual([{ id: 'ev-1', studioId: 's2', studioName: 'Alpha Studio' }])
    expect(r.total).toBe(1)
  })

  it('de-duplicates items and failedItems separately, and the same id under different providers stays', async () => {
    const user = makeUser({ locations: [S1, S2], active: 's1' })
    const getPendingApprovals = resultFor({
      s1: { providers: [prov('p', [{ id: 'x' }], [{ id: 'y' }]), prov('q', [{ id: 'x' }])], total: 3 },
      s2: { providers: [prov('p', [{ id: 'x' }, { id: 'y' }], [{ id: 'y' }, { id: 'x' }]), prov('q', [{ id: 'x' }])], total: 5 },
    })
    const r = await getPendingApprovalsAllStudios({}, user, {}, deps({ getPendingApprovals }))
    const p = r.providers.find((x) => x.key === 'p')
    expect(p.items.map((i) => [i.id, i.studioId])).toEqual([['x', 's1'], ['y', 's2']])
    expect(p.failedItems.map((i) => [i.id, i.studioId])).toEqual([['y', 's1'], ['x', 's2']])
    expect(p.count).toBe(4)
    expect(r.providers.find((x) => x.key === 'q').items).toHaveLength(1)
    expect(r.total).toBe(5)
  })

  it('a rejected studio is left out and named in failedStudios; the rest still answers', async () => {
    const user = makeUser({ locations: [S1, S2, S3], active: 's1' })
    const getPendingApprovals = vi.fn(async (_db, u) => {
      if (u.activeLocation.id === 's2') throw new Error('boom')
      return { providers: [prov('p', [{ id: u.activeLocation.id }])], total: 1 }
    })
    const r = await getPendingApprovalsAllStudios({}, user, {}, deps({ getPendingApprovals }))
    expect(r.failedStudios).toEqual(['Alpha Studio'])
    expect(r.providers[0].items.map((i) => i.studioId)).toEqual(['s1', 's3'])
    expect(r.studios.map((s) => s.id)).toEqual(['s1', 's2', 's3'])
    expect(r.total).toBe(2)
  })

  it('runs the studios in parallel', async () => {
    const user = makeUser({ locations: [S1, S2, S3], active: 's1' })
    let inFlight = 0
    let peak = 0
    const getPendingApprovals = vi.fn(async () => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      inFlight -= 1
      return { providers: [], total: 0 }
    })
    await getPendingApprovalsAllStudios({}, user, {}, deps({ getPendingApprovals }))
    expect(peak).toBe(3)
  })

  it('reports truncated and only queries the capped studios', async () => {
    const locs = Array.from({ length: 4 }, (_, i) => ({ id: `x${i}`, name: `Studio ${i}` }))
    const user = makeUser({ locations: locs, active: 'x0' })
    const getPendingApprovals = resultFor({})
    const r = await getPendingApprovalsAllStudios({}, user, { maxStudios: 2 }, deps({ getPendingApprovals }))
    expect(getPendingApprovals).toHaveBeenCalledTimes(2)
    expect(r.truncated).toBe(true)
    expect(r.studios.map((s) => s.id)).toEqual(['x0', 'x1'])
  })

  it('does not mutate the lists the per-studio calls returned', async () => {
    const user = makeUser({ locations: [S1], active: 's1' })
    const item = { id: 'a' }
    const getPendingApprovals = resultFor({ s1: { providers: [prov('p', [item])], total: 1 } })
    await getPendingApprovalsAllStudios({}, user, {}, deps({ getPendingApprovals }))
    expect(item).toEqual({ id: 'a' })
  })
})
