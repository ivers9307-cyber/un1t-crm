// W0.8 — /settings/notifications shows the caller's locations only.
//
// The registry page read EVERY active location on the platform (and
// rendered each as a link to its settings page) and counted EVERY active
// profile for its per-category "opted in" numbers, gated only by the
// `settings` permission. On a multi-tenant estate a tenant owner saw every
// other tenant's studios and headcount. Non-masters now read only the
// locations from getUserLocationIds and the profiles with a
// profile_locations row there; masters keep the platform-wide view.
//
// These tests assert the QUERIES, because that is where the leak lives.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('next/navigation', () => ({
  redirect: vi.fn((url) => {
    const err = new Error(`NEXT_REDIRECT:${url}`)
    err.digest = `NEXT_REDIRECT;${url}`
    throw err
  }),
}))

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal()),
  getCurrentUser: vi.fn(),
}))

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))

import NotificationRegistryPage from './page.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

const LOC_MINE = 'loc-a1'
const LOC_THEIRS = 'loc-b2'
const NIL = ['00000000-0000-0000-0000-000000000000']
const ME = 'u-me'
const PEER = 'u-peer'
const STRANGER = 'u-stranger'

// A recording fake: every builder call lands in `ops` as [method, ...args];
// `then` answers from a small fixture, honouring any `in` filter so the
// profile-id round trip is real rather than echoed.
function makeDb() {
  const calls = []
  const from = (table) => {
    const q = { table, ops: [] }
    calls.push(q)
    const inFilter = () => q.ops.find(([m]) => m === 'in')
    const chain = {
      then: (res) => {
        let data = []
        if (table === 'profile_locations') {
          const f = inFilter()
          const rows = [
            { profile_id: ME, location_id: LOC_MINE },
            { profile_id: PEER, location_id: LOC_MINE },
            { profile_id: PEER, location_id: LOC_MINE }, // two rows, one person
            { profile_id: STRANGER, location_id: LOC_THEIRS },
          ]
          data = f ? rows.filter(r => f[2].includes(r[f[1]])) : rows
        } else if (table === 'profiles') {
          const f = inFilter()
          const rows = [
            { id: ME, role: 'owner', active: true, permissions: {} },
            { id: PEER, role: 'staff', active: true, permissions: {} },
            { id: STRANGER, role: 'staff', active: true, permissions: {} },
          ]
          data = f ? rows.filter(r => f[2].includes(r[f[1]])) : rows
        } else if (table === 'locations') {
          const f = inFilter()
          const rows = [
            { id: LOC_MINE, name: 'Mine', slug: 'mine', active: true, notification_config: null },
            { id: LOC_THEIRS, name: 'Theirs', slug: 'theirs', active: true, notification_config: null },
          ]
          data = f ? rows.filter(r => f[2].includes(r[f[1]])) : rows
        }
        return Promise.resolve({ data, error: null }).then(res)
      },
    }
    for (const m of ['select', 'eq', 'in', 'order']) {
      chain[m] = (...args) => { q.ops.push([m, ...args]); return chain }
    }
    return chain
  }
  return { calls, from }
}

const user = ({ isMaster = false, locations = [{ id: LOC_MINE }] }) => ({
  id: ME,
  role: isMaster ? 'master' : 'owner',
  isMaster,
  profileRole: isMaster ? 'master' : 'owner',
  locations,
  rolesByLocation: Object.fromEntries(locations.map(l => [l.id, 'owner'])),
  activeLocation: { id: LOC_MINE, organization_id: 'org-a' },
  activeOrganization: { id: 'org-a' },
  orgAdminOrgIds: [],
})

const only = (db, table) => {
  const qs = db.calls.filter(c => c.table === table)
  expect(qs, `exactly one ${table} query`).toHaveLength(1)
  return qs[0]
}
const inOps = (q) => q.ops.filter(([m]) => m === 'in')

describe('/settings/notifications — scoped to the caller’s locations (W0.8)', () => {
  let db
  beforeEach(() => {
    vi.clearAllMocks()
    db = makeDb()
    createServerClient.mockReturnValue(db)
  })

  it('a non-master reads only their own locations and the people assigned there', async () => {
    getCurrentUser.mockResolvedValue(user({}))
    await NotificationRegistryPage()

    expect(inOps(only(db, 'locations'))).toEqual([['in', 'id', [LOC_MINE]]])
    expect(inOps(only(db, 'profile_locations'))).toEqual([['in', 'location_id', [LOC_MINE]]])
    // The profile ids come from that read — de-duplicated, stranger excluded.
    expect(inOps(only(db, 'profiles'))).toEqual([['in', 'id', [ME, PEER]]])
  })

  it('a non-master still only counts ACTIVE profiles and lists ACTIVE, non-anchor locations', async () => {
    getCurrentUser.mockResolvedValue(user({}))
    await NotificationRegistryPage()

    expect(only(db, 'profiles').ops).toContainEqual(['eq', 'active', true])
    const loc = only(db, 'locations').ops
    expect(loc).toContainEqual(['eq', 'active', true])
    expect(loc).toContainEqual(['eq', 'is_host_anchor', false])
  })

  it('a master keeps the platform-wide view: no in filter, no profile_locations read', async () => {
    getCurrentUser.mockResolvedValue(user({ isMaster: true }))
    await NotificationRegistryPage()

    expect(inOps(only(db, 'locations'))).toEqual([])
    expect(inOps(only(db, 'profiles'))).toEqual([])
    expect(db.calls.find(c => c.table === 'profile_locations')).toBeUndefined()
  })

  it('a non-master with no locations sees nothing — nil-uuid sentinel, never an unfiltered read', async () => {
    getCurrentUser.mockResolvedValue(user({ locations: [] }))
    await NotificationRegistryPage()

    expect(inOps(only(db, 'locations'))).toEqual([['in', 'id', NIL]])
    expect(inOps(only(db, 'profile_locations'))).toEqual([['in', 'location_id', NIL]])
    // No profile ids came back, so the sentinel again — not an empty `in`
    // (PostgREST treats `in.()` as no rows, but we never rely on that) and
    // never the whole table.
    expect(inOps(only(db, 'profiles'))).toEqual([['in', 'id', NIL]])
  })
})
