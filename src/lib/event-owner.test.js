// EVENT-OWNER.1 — who may move an event to another studio, and the studios
// the form offers.

import { describe, it, expect, vi } from 'vitest'

// The test user carries its grants directly: roles per location and the
// locations where the races permission is on.
vi.mock('@/lib/auth', () => ({
  assertLocationAccessOr404: (user, id) => ((user.locations || []).some((l) => l.id === id) ? null : { status: 404 }),
  hasRoleAtLocation: (user, id, roles) => roles.includes(user.roles?.[id]),
}))
vi.mock('@/lib/permissions', () => ({
  hasPermissionForLocation: (user, id, key) => key === 'races' && (user.races || []).includes(id),
}))

const { eventOwnerOptions, judgeEventOwnerChange } = await import('./event-owner')

const STILLORGAN = { id: 'loc-s', name: 'UN1T Stillorgan', organization_id: 'org-1', is_host_anchor: false, active: true }
const HATCH = { id: 'loc-h', name: 'UN1T Hatch Street', organization_id: 'org-1', is_host_anchor: false, active: true }
const HOST = { id: 'loc-host', name: 'Pride Training Club (host events)', organization_id: 'org-1', is_host_anchor: true, active: true }
const OTHER = { id: 'loc-o', name: 'CCF Autos', organization_id: 'org-2', is_host_anchor: false, active: true }
const ALL = [STILLORGAN, HATCH, HOST, OTHER]

const owner = (over = {}) => ({
  locations: ALL,
  roles: { 'loc-s': 'owner', 'loc-h': 'owner', 'loc-host': 'owner', 'loc-o': 'owner' },
  races: ['loc-s', 'loc-h', 'loc-host', 'loc-o'],
  ...over,
})

function fakeDb(rows = ALL, error = null) {
  return {
    from: () => ({
      select: () => ({
        in: async (_col, ids) => (error ? { data: null, error } : { data: rows.filter((r) => ids.includes(r.id)), error: null }),
      }),
    }),
  }
}

const existing = { id: 'ev-1', location_id: 'loc-s', host_id: null }

describe('eventOwnerOptions', () => {
  it('lists the org studios with events on, never host anchors or other orgs', () => {
    expect(eventOwnerOptions(owner(), { organizationId: 'org-1' }).map((o) => o.id)).toEqual(['loc-h', 'loc-s'])
  })

  it('drops a studio where events are off', () => {
    expect(eventOwnerOptions(owner({ races: ['loc-s'] }), { organizationId: 'org-1' }).map((o) => o.id)).toEqual(['loc-s'])
  })

  it('requireAdmin drops a studio where the user is not an admin', () => {
    const u = owner({ roles: { 'loc-s': 'owner', 'loc-h': 'staff' } })
    expect(eventOwnerOptions(u, { organizationId: 'org-1', requireAdmin: true }).map((o) => o.id)).toEqual(['loc-s'])
  })
})

describe('judgeEventOwnerChange', () => {
  it('no change is always fine', async () => {
    expect(await judgeEventOwnerChange({ db: fakeDb(), user: owner(), existing, targetLocationId: 'loc-s' })).toEqual({ ok: true })
    expect(await judgeEventOwnerChange({ db: fakeDb(), user: owner(), existing, targetLocationId: undefined })).toEqual({ ok: true })
  })

  it('an admin at both studios may move Stillorgan → Hatch Street', async () => {
    expect(await judgeEventOwnerChange({ db: fakeDb(), user: owner(), existing, targetLocationId: 'loc-h' })).toEqual({ ok: true })
  })

  it('refuses without admin at the CURRENT studio', async () => {
    const u = owner({ roles: { 'loc-s': 'staff', 'loc-h': 'owner' } })
    const r = await judgeEventOwnerChange({ db: fakeDb(), user: u, existing, targetLocationId: 'loc-h' })
    expect(r).toMatchObject({ ok: false, status: 403 })
  })

  it('refuses without admin at the TARGET studio', async () => {
    const u = owner({ roles: { 'loc-s': 'owner', 'loc-h': 'head_coach' } })
    const r = await judgeEventOwnerChange({ db: fakeDb(), user: u, existing, targetLocationId: 'loc-h' })
    expect(r).toMatchObject({ ok: false, status: 403 })
  })

  it('404s a studio the user has no access to', async () => {
    const u = owner({ locations: [STILLORGAN] })
    const r = await judgeEventOwnerChange({ db: fakeDb(), user: u, existing, targetLocationId: 'loc-h' })
    expect(r).toMatchObject({ ok: false, status: 404 })
  })

  it('refuses a studio with events off', async () => {
    const r = await judgeEventOwnerChange({ db: fakeDb(), user: owner({ races: ['loc-s'] }), existing, targetLocationId: 'loc-h' })
    expect(r).toMatchObject({ ok: false, status: 403 })
  })

  it('refuses a host anchor and another organisation', async () => {
    expect(await judgeEventOwnerChange({ db: fakeDb(), user: owner(), existing, targetLocationId: 'loc-host' }))
      .toMatchObject({ ok: false, status: 400, error: 'invalid_location' })
    expect(await judgeEventOwnerChange({ db: fakeDb(), user: owner(), existing, targetLocationId: 'loc-o' }))
      .toMatchObject({ ok: false, status: 400, error: 'invalid_location' })
  })

  it("refuses a host's event, and a move that also assigns a host", async () => {
    expect(await judgeEventOwnerChange({ db: fakeDb(), user: owner(), existing: { ...existing, host_id: 'h-1' }, targetLocationId: 'loc-h' }))
      .toMatchObject({ ok: false, status: 400 })
    expect(await judgeEventOwnerChange({ db: fakeDb(), user: owner(), existing, targetLocationId: 'loc-h', nextHostId: 'h-1' }))
      .toMatchObject({ ok: false, status: 400 })
  })

  it('an unreadable locations table changes nothing', async () => {
    const r = await judgeEventOwnerChange({ db: fakeDb(ALL, { message: 'down' }), user: owner(), existing, targetLocationId: 'loc-h' })
    expect(r).toMatchObject({ ok: false, status: 500 })
  })
})
