// WIDGET.1 — GET /api/widget/devices, the config picker's data source.
//
// withAuth itself is stubbed (same house style as checklists/templates/[id]
// and other withAuth-wrapped route tests) — this suite is about the
// COMPOSITION logic, not re-proving withAuth's own gate.
//
// Two things this suite exists to pin:
//   1. Doors MUST come from listAllowedDoors, never a raw listDoors() call
//      — that's the UNIFI-DOORS-SCOPE allowlist barrier (mig 182).
//   2. Speakers MUST come from Sonos PLAYERS, never groups — player ids are
//      permanent, group ids are ephemeral (src/lib/sonos/groups.js:28).
//
// mapGroups (src/lib/sonos/groups.js) is REAL, not mocked — it's a pure
// mapper, and the players-not-groups assertion only means something if the
// real extraction logic runs.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  user: { id: 'u1', role: 'manager', activeLocation: { id: 'loc-1' } },
  locationId: 'loc-1',
  db: null,
}))

vi.mock('@/lib/with-auth', () => ({
  withAuth: (opts, handler) => async (request, ctx) =>
    handler({
      user: h.user,
      db: h.db,
      locationId: h.locationId,
      request,
      params: ctx?.params ? await ctx.params : undefined,
    }),
}))

vi.mock('@/lib/permissions', () => ({ hasPermissionForLocation: vi.fn() }))
vi.mock('@/lib/studio-doors', () => ({ listAllowedDoors: vi.fn() }))
// Mocked alongside listAllowedDoors purely so the security test can prove
// the route never reaches around the allowlist helper to call the raw
// UniFi lister directly. listDoors stays a plain vi.fn(); real listDoors
// would hit the network if it were ever (wrongly) called.
vi.mock('@/lib/unifi-access', async () => {
  const actual = await vi.importActual('@/lib/unifi-access')
  return { ...actual, listDoors: vi.fn() }
})
vi.mock('@/lib/sonos/client', () => ({
  getSonosConfig: vi.fn(),
  withFreshToken: vi.fn(),
  sonosGetGroups: vi.fn(),
}))

import { GET } from './route.js'
import { hasPermissionForLocation } from '@/lib/permissions'
import { listAllowedDoors } from '@/lib/studio-doors'
import { listDoors } from '@/lib/unifi-access'
import { getSonosConfig, withFreshToken, sonosGetGroups } from '@/lib/sonos/client'

const LOCATION_ROW = { id: 'loc-1', name: 'Stillorgan', settings: {} }
const SONOS_CFG = { clientId: 'id', clientSecret: 'secret', redirectUri: 'https://x.test/cb' }

const DOOR_ROWS = [{ id: 'door-1', name: 'Front Door' }]
const AC_ROWS = [{ id: 'ac-1', label: 'Studio A' }]
const SHELLY_ROWS = [{ id: 'plug-1', name: 'Fan Plug' }]

// Groups response with a group id that differs from BOTH player ids — the
// speakers-from-players regression would surface the group id ('grp-XYZ')
// as a device id, or fail to surface the two real player ids at all.
const GROUPS_BODY = {
  groups: [{
    id: 'grp-XYZ',
    name: 'Whole studio',
    coordinatorId: 'player-1',
    playbackState: 'PLAYBACK_STATE_PLAYING',
    playerIds: ['player-1', 'player-2'],
  }],
  players: [
    { id: 'player-1', name: 'Studio Left' },
    { id: 'player-2', name: 'Studio Right' },
  ],
}

function req() {
  return new Request('https://x.test/api/widget/devices', { method: 'GET' })
}

// Configurable fake DB. Tables the route touches: locations (door source's
// location-row lookup), ac_devices, shelly_devices.
function mockDb({
  location = LOCATION_ROW,
  locationError = null,
  acRows = [],
  acError = null,
  shellyRows = [],
  shellyError = null,
} = {}) {
  return {
    from: (table) => {
      if (table === 'locations') {
        return { select: () => ({ eq: () => ({ single: () =>
          Promise.resolve({ data: location, error: locationError }) }) }) }
      }
      if (table === 'ac_devices') {
        return { select: () => ({ eq: () => ({ eq: () =>
          Promise.resolve({ data: acRows, error: acError }) }) }) }
      }
      if (table === 'shelly_devices') {
        return { select: () => ({ eq: () =>
          Promise.resolve({ data: shellyRows, error: shellyError }) }) }
      }
      throw new Error(`unexpected table ${table}`)
    },
  }
}

// hasPermissionForLocation gate map: which of studio_management /
// device_control this "user" holds.
function gate({ studio_management = false, device_control = false } = {}) {
  hasPermissionForLocation.mockImplementation((_user, _locationId, key) => {
    if (key === 'studio_management') return studio_management
    if (key === 'device_control') return device_control
    return false
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  h.db = mockDb({ acRows: AC_ROWS, shellyRows: SHELLY_ROWS })
  listAllowedDoors.mockResolvedValue({ ok: true, doors: DOOR_ROWS, scope: 'allowlist' })
  getSonosConfig.mockReturnValue(SONOS_CFG)
  withFreshToken.mockResolvedValue({ ok: true, token: 'tok', householdId: 'hh-1' })
  sonosGetGroups.mockResolvedValue({ ok: true, statusCode: 200, body: GROUPS_BODY })
})

describe('GET /api/widget/devices', () => {
  it('returns all four kinds when both permissions are held', async () => {
    gate({ studio_management: true, device_control: true })

    const res = await GET(req())
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.data.degraded).toEqual([])
    expect(body.data.devices).toEqual(expect.arrayContaining([
      { kind: 'door', id: 'door-1', label: 'Front Door' },
      { kind: 'ac', id: 'ac-1', label: 'Studio A' },
      { kind: 'plug', id: 'plug-1', label: 'Fan Plug' },
      { kind: 'speaker', id: 'player-1', label: 'Studio Left' },
      { kind: 'speaker', id: 'player-2', label: 'Studio Right' },
    ]))
    expect(body.data.devices).toHaveLength(5)
  })

  it('omits doors and ac without studio_management', async () => {
    gate({ studio_management: false, device_control: true })

    const res = await GET(req())
    const body = await res.json()

    const kinds = body.data.devices.map((d) => d.kind)
    expect(kinds).not.toContain('door')
    expect(kinds).not.toContain('ac')
    expect(kinds.sort()).toEqual(['plug', 'speaker', 'speaker'])
    expect(listAllowedDoors).not.toHaveBeenCalled()
  })

  it('omits plugs and speakers without device_control', async () => {
    gate({ studio_management: true, device_control: false })

    const res = await GET(req())
    const body = await res.json()

    const kinds = body.data.devices.map((d) => d.kind)
    expect(kinds).not.toContain('plug')
    expect(kinds).not.toContain('speaker')
    expect(kinds.sort()).toEqual(['ac', 'door'])
    // No Sonos work should even be attempted when the gate fails.
    expect(getSonosConfig).not.toHaveBeenCalled()
  })

  it('returns an empty device list with status 200 (not an error) when neither permission is held', async () => {
    gate({ studio_management: false, device_control: false })

    const res = await GET(req())
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toEqual({ success: true, data: { devices: [], degraded: [] } })
    expect(listAllowedDoors).not.toHaveBeenCalled()
    expect(getSonosConfig).not.toHaveBeenCalled()
  })

  it('degrades one failing source while the others still return', async () => {
    gate({ studio_management: true, device_control: true })
    h.db = mockDb({ acRows: AC_ROWS, shellyRows: [], shellyError: { message: 'boom' } })

    const res = await GET(req())
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data.degraded).toEqual(['plug'])
    const kinds = body.data.devices.map((d) => d.kind)
    expect(kinds).toContain('door')
    expect(kinds).toContain('ac')
    expect(kinds).toContain('speaker')
    expect(kinds).not.toContain('plug')
  })

  it('treats a not-connected Sonos account as a normal empty result, not a degraded source', async () => {
    gate({ studio_management: true, device_control: true })
    withFreshToken.mockResolvedValue({ ok: false, reason: 'not_connected' })

    const res = await GET(req())
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data.degraded).toEqual([])
    const kinds = body.data.devices.map((d) => d.kind)
    expect(kinds).not.toContain('speaker')
    // The other device_control-gated source is unaffected.
    expect(kinds).toContain('plug')
  })

  it('security: door entries are the allowlist-intersected ones from listAllowedDoors, never raw listDoors', async () => {
    gate({ studio_management: true, device_control: false })

    const res = await GET(req())
    const body = await res.json()

    expect(listAllowedDoors).toHaveBeenCalledWith(
      h.db,
      { user: h.user, location: LOCATION_ROW, locationId: h.locationId }
    )
    expect(listDoors).not.toHaveBeenCalled()
    expect(body.data.devices).toContainEqual({ kind: 'door', id: 'door-1', label: 'Front Door' })
  })

  it('speakers come from Sonos players, never groups', async () => {
    gate({ studio_management: false, device_control: true })

    const res = await GET(req())
    const body = await res.json()

    const speakerIds = body.data.devices.filter((d) => d.kind === 'speaker').map((d) => d.id)
    expect(speakerIds.sort()).toEqual(['player-1', 'player-2'])
    // The group id must never leak out as a device id.
    expect(speakerIds).not.toContain('grp-XYZ')
  })
})
