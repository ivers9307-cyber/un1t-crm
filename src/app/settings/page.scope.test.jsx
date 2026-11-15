// SETTINGSSCOPE.1 — audit 2026-11-15 item 9: the Settings hub read every
// studio in the estate and counted every profile on the platform, on the
// service-role client, for anyone holding `settings` (managers and owners by
// default). A master keeps the estate view; anyone else sees their own studios
// and the staff at them, and Edit only where the edit page would let them in.
// Fictional ids only.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

const state = { user: null }
vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(async () => state.user),
  getUserLocationIds: (u) => (u?.locations || []).map((l) => l.id),
}))
vi.mock('@/lib/permissions', () => ({ hasPermission: () => true }))
vi.mock('next/navigation', () => ({ redirect: vi.fn() }))
vi.mock('next/link', () => ({ default: ({ href, children }) => <a href={href}>{children}</a> }))
vi.mock('@/lib/settings-tree', () => ({ visibleSettingsTree: () => [] }))
vi.mock('@/lib/staff-tombstone', () => ({ excludeTombstones: (q) => q }))
vi.mock('@/components/settings/XeroCallbackNotice', () => ({ default: () => null }))

const LOC_A = 'a0000000-0000-0000-0000-00000000000a'
const LOC_B = 'b0000000-0000-0000-0000-00000000000b'
const LOC_OTHER_ORG = 'c0000000-0000-0000-0000-00000000000c'
const ALL_LOCATIONS = [
  { id: LOC_A, name: 'Studio A', slug: 'a', address: 'A street', active: true },
  { id: LOC_B, name: 'Studio B', slug: 'b', address: 'B street', active: true },
  { id: LOC_OTHER_ORG, name: 'Other Org Studio', slug: 'c', address: 'C street', active: true },
]
const MEMBERSHIPS = [
  { profile_id: 'p1', location_id: LOC_A }, { profile_id: 'p2', location_id: LOC_A },
  { profile_id: 'p1', location_id: LOC_B }, { profile_id: 'p9', location_id: LOC_OTHER_ORG },
]

let calls
function fakeDb() {
  calls = []
  return {
    from: (table) => {
      const filters = []
      const q = {
        select: (cols, opts) => { calls.push({ table, cols, opts }); return q },
        eq: (c, v) => { filters.push(['eq', c, v]); return q },
        in: (c, v) => { filters.push(['in', c, v]); calls.push({ table, in: [c, v] }); return q },
        order: () => q,
        then: (res, rej) => {
          let rows = table === 'locations' ? ALL_LOCATIONS : table === 'profile_locations' ? MEMBERSHIPS : []
          for (const [op, c, v] of filters) if (op === 'in') rows = rows.filter((r) => v.includes(r[c]))
          const out = table === 'profiles' ? { count: 42, error: null } : { data: rows, error: null }
          return Promise.resolve(out).then(res, rej)
        },
      }
      return q
    },
  }
}
vi.mock('@/lib/supabase', () => ({ createServerClient: () => fakeDb() }))

import SettingsPage, { loadSettingsHubCounts } from './page.js'

const render = async () => renderToStaticMarkup(await SettingsPage({ searchParams: Promise.resolve({}) }))

beforeEach(() => { state.user = null })

describe('loadSettingsHubCounts', () => {
  it('a non-master sees only their studios, and the staff at them (distinct)', async () => {
    const out = await loadSettingsHubCounts(fakeDb(), { isMaster: false, myLocationIds: [LOC_A, LOC_B] })
    expect(out.locations.map((l) => l.id)).toEqual([LOC_A, LOC_B])
    expect(out.staffCount).toBe(2)
    expect(calls.some((c) => c.table === 'profiles')).toBe(false)
  })
  it('no studios at all reads nothing and shows nothing', async () => {
    const out = await loadSettingsHubCounts(fakeDb(), { isMaster: false, myLocationIds: [] })
    expect(out).toEqual({ staffCount: 0, locations: [] })
    expect(calls).toHaveLength(0)
  })
  it('a master keeps the estate view', async () => {
    const out = await loadSettingsHubCounts(fakeDb(), { isMaster: true, myLocationIds: [LOC_A] })
    expect(out.locations).toHaveLength(3)
    expect(out.staffCount).toBe(42)
  })
  it('never reads locations with select("*") (credential columns stay on the server)', async () => {
    await loadSettingsHubCounts(fakeDb(), { isMaster: true, myLocationIds: [] })
    expect(calls.filter((c) => c.table === 'locations').every((c) => c.cols !== '*')).toBe(true)
  })
})

describe('the Settings page', () => {
  it('a manager at Studio A sees Studio A only, and no Edit link', async () => {
    state.user = { id: 'm1', role: 'manager', profileRole: 'staff', locations: [{ id: LOC_A }], rolesByLocation: { [LOC_A]: 'manager' } }
    const html = await render()
    expect(html).toContain('Studio A')
    expect(html).not.toContain('Studio B')
    expect(html).not.toContain('Other Org Studio')
    expect(html).not.toContain(`/settings/locations/${LOC_A}`)
  })
  it('an owner at A and manager at B gets Edit at A only', async () => {
    state.user = { id: 'o1', role: 'owner', profileRole: 'staff', locations: [{ id: LOC_A }, { id: LOC_B }], rolesByLocation: { [LOC_A]: 'owner', [LOC_B]: 'manager' } }
    const html = await render()
    expect(html).toContain(`/settings/locations/${LOC_A}`)
    expect(html).not.toContain(`/settings/locations/${LOC_B}`)
    expect(html).not.toContain('Other Org Studio')
  })
})
