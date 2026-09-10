// src/lib/widget-auth.test.js
// WIDGET.1 — token to user object. The shape it returns is the contract:
// hasPermission() and hasPermissionForLocation() must work on it unchanged.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/role-templates', () => ({
  loadRoleTemplatesForLocations: vi.fn(async () => ({
    roleTemplatesByLocation: {}, acDeviceTemplatesByLocation: {},
  })),
}))

import { getWidgetUser } from './widget-auth'
import { generateWidgetToken, hashWidgetToken } from './widget-token'
import { loadRoleTemplatesForLocations } from '@/lib/role-templates'

const LOC = 'loc-1'
const PROFILE = 'prof-1'

const TOKEN = generateWidgetToken()
const HASH = hashWidgetToken(TOKEN)

const requestWith = (auth) => ({ headers: { get: (k) => (k.toLowerCase() === 'authorization' ? auth : null) } })

/**
 * Minimal table-router db double. Each table returns a terminal thenable so
 * the builder chain resolves the way supabase-js does.
 */
function makeDb(tables) {
  const update = vi.fn(() => ({ eq: vi.fn(() => ({ then: (res) => res({ error: null }) })) }))
  const db = {
    _update: update,
    from: vi.fn((table) => {
      const rows = tables[table]
      const chain = {
        select: vi.fn(() => chain),
        eq: vi.fn(() => chain),
        is: vi.fn(() => chain),
        maybeSingle: async () => rows ?? { data: null, error: null },
        update,
      }
      return chain
    }),
  }
  return db
}

const okTables = (over = {}) => ({
  widget_tokens: { data: { id: 'tok-1', profile_id: PROFILE, location_id: LOC, revoked_at: null }, error: null },
  profiles: { data: { id: PROFILE, email: 'a@b.c', full_name: 'A B', role: 'manager', employment_type: 'fte' }, error: null },
  profile_locations: { data: { location_id: LOC, role: 'manager', permissions: { device_control: true } }, error: null },
  locations: { data: { id: LOC, name: 'Stillorgan', features: { sonos: true } }, error: null },
  ...over,
})

beforeEach(() => { vi.clearAllMocks() })

describe('getWidgetUser', () => {
  it('returns null when there is no Authorization header', async () => {
    expect(await getWidgetUser(makeDb(okTables()), requestWith(null))).toBe(null)
  })

  it('returns null for a Supabase JWT (not a widget token)', async () => {
    const db = makeDb(okTables())
    expect(await getWidgetUser(db, requestWith('Bearer eyJhbGciOiJIUzI1NiJ9.a.b'))).toBe(null)
    expect(db.from).not.toHaveBeenCalled()
  })

  it('returns null when the token has no live row', async () => {
    const db = makeDb(okTables({ widget_tokens: { data: null, error: null } }))
    expect(await getWidgetUser(db, requestWith(`Bearer ${TOKEN}`))).toBe(null)
  })

  it('returns null when the profile is gone', async () => {
    const db = makeDb(okTables({ profiles: { data: null, error: null } }))
    expect(await getWidgetUser(db, requestWith(`Bearer ${TOKEN}`))).toBe(null)
  })

  it('returns null when the person no longer holds an assignment at that location', async () => {
    // The revocation path that needs no revocation: remove someone from a
    // studio and their widget for it stops working on the next tap.
    const db = makeDb(okTables({ profile_locations: { data: null, error: null } }))
    expect(await getWidgetUser(db, requestWith(`Bearer ${TOKEN}`))).toBe(null)
  })

  it('builds a user whose activeLocation is the TOKEN location', async () => {
    const u = await getWidgetUser(makeDb(okTables()), requestWith(`Bearer ${TOKEN}`))
    expect(u.activeLocation).toEqual({ id: LOC, name: 'Stillorgan', features: { sonos: true } })
    expect(u.id).toBe(PROFILE)
  })

  it('stamps authSource so withAuth can default-deny', async () => {
    const u = await getWidgetUser(makeDb(okTables()), requestWith(`Bearer ${TOKEN}`))
    expect(u.authSource).toBe('widget')
    expect(u.widgetTokenId).toBe('tok-1')
  })

  it('populates the shape hasPermissionForLocation reads', async () => {
    const u = await getWidgetUser(makeDb(okTables()), requestWith(`Bearer ${TOKEN}`))
    expect(u.assignmentsByLocation[LOC]).toEqual({ location_id: LOC, role: 'manager', permissions: { device_control: true } })
    expect(u.rolesByLocation).toEqual({ [LOC]: 'manager' })
    expect(u.locations).toEqual([{ id: LOC, name: 'Stillorgan', features: { sonos: true } }])
    expect(u.role).toBe('manager')
  })

  it('resolves role templates through the shared loader', async () => {
    loadRoleTemplatesForLocations.mockResolvedValueOnce({
      roleTemplatesByLocation: { [LOC]: { device_control: false } },
      acDeviceTemplatesByLocation: {},
    })
    const u = await getWidgetUser(makeDb(okTables()), requestWith(`Bearer ${TOKEN}`))
    expect(u.roleTemplatesByLocation[LOC]).toEqual({ device_control: false })
    expect(u.activeRoleTemplate).toEqual({ device_control: false })
  })

  it('never reports master, whatever the profile row says', async () => {
    // A widget token is location-scoped by construction. Granting it the
    // master bypass would let a lost phone act estate-wide.
    const db = makeDb(okTables({
      profiles: { data: { id: PROFILE, email: 'm@b.c', full_name: 'M', role: 'master', employment_type: null }, error: null },
    }))
    const u = await getWidgetUser(db, requestWith(`Bearer ${TOKEN}`))
    expect(u.isMaster).toBe(false)
    expect(u.role).toBe('manager')      // the assignment's role, not 'master'
    expect(u.profileRole).toBe('master')
  })

  it('touches last_used_at without blocking the result', async () => {
    const db = makeDb(okTables())
    const u = await getWidgetUser(db, requestWith(`Bearer ${TOKEN}`))
    expect(u).not.toBe(null)
    expect(db._update).toHaveBeenCalledWith(expect.objectContaining({ last_used_at: expect.any(String) }))
  })

  it('looks the token up by HASH, never by plaintext', async () => {
    const db = makeDb(okTables())
    await getWidgetUser(db, requestWith(`Bearer ${TOKEN}`))
    const chain = db.from.mock.results[0].value
    expect(chain.eq).toHaveBeenCalledWith('token_hash', HASH)
    const passed = chain.eq.mock.calls.flat()
    expect(passed).not.toContain(TOKEN)
  })
})
