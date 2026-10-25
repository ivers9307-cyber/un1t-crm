// C115 POLICYVIEWERS.1 — the per-version viewer report lists the caller's
// organisation's people only. Before, listVersionViewers read every active
// profile (and every viewer) in the estate, so an owner at one gym saw the
// name and email of every other tenant's staff on the "Haven't opened" list.
//
// makeFakeDb really filters (.eq/.in), so a read that forgets the scope fails
// here instead of passing vacuously.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeFakeDb } from './api-auth.test-helpers.js'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))

const { createServerClient } = await import('@/lib/supabase')
const { listVersionViewers, currentVersionOpenCounts } = await import('./policies.js')

const ORG = 'org-own'
const FOREIGN = 'org-foreign'
const VERSION = 'pv-1'

const profile = (id, full_name, email, active = true) => ({ id, full_name, email, active })

function fixture() {
  return {
    locations: [
      { id: 'loc-a', organization_id: ORG },
      { id: 'loc-b', organization_id: ORG },
      { id: 'loc-x', organization_id: FOREIGN },
    ],
    profile_locations: [
      { profile_id: 'own-viewer', location_id: 'loc-a' },
      { profile_id: 'own-pending', location_id: 'loc-b' },
      { profile_id: 'foreign-viewer', location_id: 'loc-x' },
      { profile_id: 'foreign-pending', location_id: 'loc-x' },
    ],
    profile_organizations: [
      { profile_id: 'own-org-admin', organization_id: ORG, role: 'org_admin' },
      { profile_id: 'foreign-org-admin', organization_id: FOREIGN, role: 'org_admin' },
    ],
    profiles: [
      profile('own-viewer', 'Own Viewer', 'own.viewer@example.com'),
      profile('own-pending', 'Own Pending', 'own.pending@example.com'),
      profile('own-org-admin', 'Own Admin', 'own.admin@example.com'),
      profile('foreign-viewer', 'Foreign Viewer', 'foreign.viewer@example.com'),
      profile('foreign-pending', 'Foreign Pending', 'foreign.pending@example.com'),
      profile('foreign-org-admin', 'Foreign Admin', 'foreign.admin@example.com'),
    ],
    policy_views: [
      {
        policy_version_id: VERSION, profile_id: 'own-viewer', started_at: '2026-09-01T10:00:00Z',
        ended_at: '2026-09-01T10:05:00Z', total_duration_seconds: 300, section_dwell: {}, viewed_via: 'web',
        profiles: { full_name: 'Own Viewer', email: 'own.viewer@example.com' },
      },
      {
        policy_version_id: VERSION, profile_id: 'foreign-viewer', started_at: '2026-09-02T10:00:00Z',
        ended_at: '2026-09-02T10:05:00Z', total_duration_seconds: 300, section_dwell: {}, viewed_via: 'web',
        profiles: { full_name: 'Foreign Viewer', email: 'foreign.viewer@example.com' },
      },
    ],
  }
}

const OWNER = { id: 'caller', isMaster: false, role: 'owner', activeOrganization: { id: ORG }, orgAdminOrgIds: [] }
const MASTER = { id: 'master', isMaster: true, role: 'master', activeOrganization: { id: ORG }, orgAdminOrgIds: [] }

const ids = (rows, key) => rows.map((r) => r[key]).sort()

beforeEach(() => { createServerClient.mockReset() })

describe('listVersionViewers — the caller\'s organisation only', () => {
  it('an owner sees their organisation\'s viewers and outstanding people, never another tenant\'s', async () => {
    createServerClient.mockReturnValue(makeFakeDb(fixture()))
    const { viewers, outstanding, all_views } = await listVersionViewers(VERSION, OWNER)
    expect(ids(viewers, 'profile_id')).toEqual(['own-viewer'])
    expect(ids(outstanding, 'id')).toEqual(['own-org-admin', 'own-pending'])
    expect(ids(all_views, 'profile_id')).toEqual(['own-viewer'])
    const text = JSON.stringify({ viewers, outstanding, all_views })
    expect(text).not.toMatch(/foreign/i)
  })

  it('an owner with no active organisation sees nobody', async () => {
    createServerClient.mockReturnValue(makeFakeDb(fixture()))
    const res = await listVersionViewers(VERSION, { ...OWNER, activeOrganization: null })
    expect(res).toEqual({ viewers: [], outstanding: [], all_views: [] })
  })

  it('no caller sees nobody', async () => {
    createServerClient.mockReturnValue(makeFakeDb(fixture()))
    expect(await listVersionViewers(VERSION, null)).toEqual({ viewers: [], outstanding: [], all_views: [] })
  })

  it('a master keeps the estate (the platform view)', async () => {
    createServerClient.mockReturnValue(makeFakeDb(fixture()))
    const { viewers, outstanding } = await listVersionViewers(VERSION, MASTER)
    expect(ids(viewers, 'profile_id')).toEqual(['foreign-viewer', 'own-viewer'])
    expect(outstanding).toHaveLength(4)
  })

  it('an inactive person is never outstanding', async () => {
    const t = fixture()
    t.profiles.find((p) => p.id === 'own-pending').active = false
    createServerClient.mockReturnValue(makeFakeDb(t))
    const { outstanding } = await listVersionViewers(VERSION, OWNER)
    expect(ids(outstanding, 'id')).toEqual(['own-org-admin'])
  })

  it('a failed read throws (a 500), never an empty or unscoped list', async () => {
    const db = makeFakeDb(fixture())
    const realFrom = db.from
    db.from = (table) => {
      const b = realFrom(table)
      if (table === 'profiles') b.then = (resolve) => Promise.resolve({ data: null, error: { message: 'boom' } }).then(resolve)
      return b
    }
    createServerClient.mockReturnValue(db)
    await expect(listVersionViewers(VERSION, OWNER)).rejects.toThrow(/boom/)
  })
})

// The /policies/manage list's "N / M opened" column counts the same people
// the per-version page lists. Before, it counted every viewer and every active
// profile in the estate, so the list read "2 / 6" while the version page an
// owner opened said 1 opened, 2 outstanding (and it told one tenant another's
// headcount).
describe('currentVersionOpenCounts — the same people as listVersionViewers', () => {
  it('an owner counts their organisation\'s completed viewers and active people only', async () => {
    createServerClient.mockReturnValue(makeFakeDb(fixture()))
    const { viewerCount, activeStaffCount } = await currentVersionOpenCounts([VERSION], OWNER)
    expect(viewerCount.get(VERSION)).toBe(1)
    expect(activeStaffCount).toBe(3)
  })

  it('a master keeps the estate', async () => {
    createServerClient.mockReturnValue(makeFakeDb(fixture()))
    const { viewerCount, activeStaffCount } = await currentVersionOpenCounts([VERSION], MASTER)
    expect(viewerCount.get(VERSION)).toBe(2)
    expect(activeStaffCount).toBe(6)
  })

  it('an owner with no active organisation counts nobody', async () => {
    createServerClient.mockReturnValue(makeFakeDb(fixture()))
    const { viewerCount, activeStaffCount } = await currentVersionOpenCounts([VERSION], { ...OWNER, activeOrganization: null })
    expect(viewerCount.get(VERSION) || 0).toBe(0)
    expect(activeStaffCount).toBe(0)
  })

  it('an unfinished view is not counted, and a person is counted once', async () => {
    const t = fixture()
    t.policy_views.push(
      { ...t.policy_views[0], started_at: '2026-09-03T10:00:00Z' },
      { ...t.policy_views[0], profile_id: 'own-pending', ended_at: null },
    )
    createServerClient.mockReturnValue(makeFakeDb(t))
    const { viewerCount } = await currentVersionOpenCounts([VERSION], OWNER)
    expect(viewerCount.get(VERSION)).toBe(1)
  })

  it('a failed read throws, never a zero passed off as the answer', async () => {
    const db = makeFakeDb(fixture())
    const realFrom = db.from
    db.from = (table) => {
      const b = realFrom(table)
      if (table === 'policy_views') b.then = (resolve) => Promise.resolve({ data: null, error: { message: 'boom' } }).then(resolve)
      return b
    }
    createServerClient.mockReturnValue(db)
    await expect(currentVersionOpenCounts([VERSION], OWNER)).rejects.toThrow(/boom/)
  })
})
