// src/app/api/studio-management/unlock/route.test.js
// WIDGET.1 — characterisation tests written BEFORE migrating this route
// from its hand-rolled getCurrentUser()/hasPermission() preamble to
// withAuth. This route opens physical doors, so every early return and its
// status code is pinned here first; the migration and the widget-token
// opt-in that follows must not move a single one of them.
//
// Permission key: 'studio_management'. Location: user.activeLocation?.id.
// UniFi client seam: getUnifiConfig + remoteUnlockDoor (src/lib/unifi-access.js)
// — stubbed here over the real module so `UnifiError` stays a real class
// (the route branches on `e instanceof UnifiError`).

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/widget-auth', () => ({ getWidgetUser: vi.fn() }))
vi.mock('@/lib/audit', () => ({ logAuditEvent: vi.fn() }))
vi.mock('@/lib/unifi-access', async () => {
  const actual = await vi.importActual('@/lib/unifi-access')
  return { ...actual, getUnifiConfig: vi.fn(), remoteUnlockDoor: vi.fn() }
})

import { POST } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { getWidgetUser } from '@/lib/widget-auth'
import { logAuditEvent } from '@/lib/audit'
import { getUnifiConfig, remoteUnlockDoor, UnifiError } from '@/lib/unifi-access'

const LOC = 'a0000000-0000-0000-0000-000000000001'
const LOCATION_ROW = { id: LOC, name: 'Stillorgan', settings: {} }
const CFG = { configured: true, host: 'unifi.test', token: 't' }

// studio_management defaults: manager/owner true, staff/front_desk/head_coach
// false (shared/permissions.js DEFAULT_WEB_PERMISSIONS_BY_ROLE) — the REAL
// hasPermission runs here, it is not mocked.
const manager = {
  id: 'u1', role: 'manager', activeLocation: { id: LOC },
  full_name: 'Ren Manager', email: 'ren@x.test',
}
const staffNoPerm = { id: 'u2', role: 'staff', activeLocation: { id: LOC } }
const managerNoLocation = { id: 'u3', role: 'manager', activeLocation: null }

function postReq(body) {
  return new Request('https://x.test/api/studio-management/unlock', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
}
const validBody = (overrides = {}) => ({ door_id: 'door-1', ...overrides })

// Configurable fake DB. Tables: profile_locations (the UNIFI-DOORS-SCOPE
// allowlist read), locations (name + settings for the config dual-read),
// activities (the fire-and-forget timeline row).
function mockDb({ assignment = { unifi_door_ids: null }, location = LOCATION_ROW } = {}) {
  const activities = []
  const db = {
    activities,
    from: (table) => {
      if (table === 'profile_locations') return {
        select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: () =>
          Promise.resolve({ data: assignment, error: null }) }) }) }),
      }
      if (table === 'locations') return {
        select: () => ({ eq: () => ({ single: () =>
          Promise.resolve({ data: location, error: null }) }) }),
      }
      if (table === 'activities') return {
        insert: (row) => { activities.push(row); return Promise.resolve({ error: null }) },
      }
      throw new Error(`unexpected table ${table}`)
    },
  }
  createServerClient.mockReturnValue(db)
  return db
}

beforeEach(() => {
  vi.clearAllMocks()
  mockDb()
  getUnifiConfig.mockResolvedValue(CFG)
  remoteUnlockDoor.mockResolvedValue({ code: 'SUCCESS' })
})

describe('POST /api/studio-management/unlock — preserved auth behaviour', () => {
  it('401s when unauthenticated (no session, no widget token)', async () => {
    getCurrentUser.mockResolvedValue(null)
    getWidgetUser.mockResolvedValue(null)
    const res = await POST(postReq(validBody()))
    const body = await res.json()
    expect(res.status).toBe(401)
    expect(body).toEqual({ success: false, error: 'Unauthorized' })
    expect(remoteUnlockDoor).not.toHaveBeenCalled()
  })

  it('403s when authenticated but lacking studio_management', async () => {
    getCurrentUser.mockResolvedValue(staffNoPerm)
    const res = await POST(postReq(validBody()))
    const body = await res.json()
    expect(res.status).toBe(403)
    expect(body).toEqual({
      success: false,
      error: 'Studio management is not enabled for your role at this location.',
    })
    expect(remoteUnlockDoor).not.toHaveBeenCalled()
  })

  it('400s when permitted but there is no active location', async () => {
    getCurrentUser.mockResolvedValue(managerNoLocation)
    const res = await POST(postReq(validBody()))
    const body = await res.json()
    expect(res.status).toBe(400)
    expect(body).toEqual({ success: false, error: 'No active location.' })
    expect(remoteUnlockDoor).not.toHaveBeenCalled()
  })

  it('400s on a body that fails the zod schema (no door_id)', async () => {
    getCurrentUser.mockResolvedValue(manager)
    const res = await POST(postReq({ door_name: 'Front' }))
    const body = await res.json()
    expect(res.status).toBe(400)
    expect(body.success).toBe(false)
    expect(body.error).toBe('Invalid request body')
    expect(remoteUnlockDoor).not.toHaveBeenCalled()
  })
})

describe('POST /api/studio-management/unlock — preserved door-scope behaviour', () => {
  // UNIFI-DOORS-SCOPE is the actual security barrier; a hand-crafted POST
  // must not reach a door outside the caller's allowlist.
  it('403s when the door is not in the caller\'s allowlist', async () => {
    getCurrentUser.mockResolvedValue(manager)
    mockDb({ assignment: { unifi_door_ids: ['door-other'] } })
    const res = await POST(postReq(validBody()))
    const body = await res.json()
    expect(res.status).toBe(403)
    expect(body).toEqual({
      success: false,
      error: 'You are not authorised to unlock this door. Ask an admin to add it to your access list.',
    })
    expect(remoteUnlockDoor).not.toHaveBeenCalled()
  })

  it('allows a door that IS in the allowlist', async () => {
    getCurrentUser.mockResolvedValue(manager)
    mockDb({ assignment: { unifi_door_ids: ['door-1', 'door-2'] } })
    const res = await POST(postReq(validBody()))
    expect(res.status).toBe(200)
    expect(remoteUnlockDoor).toHaveBeenCalled()
  })

  // mig 182 left manager+ roles NULL = legacy fallback, all doors permitted.
  it('treats a NULL allowlist as unrestricted', async () => {
    getCurrentUser.mockResolvedValue(manager)
    mockDb({ assignment: { unifi_door_ids: null } })
    const res = await POST(postReq(validBody()))
    expect(res.status).toBe(200)
  })

  it('treats an empty allowlist as no doors permitted', async () => {
    getCurrentUser.mockResolvedValue(manager)
    mockDb({ assignment: { unifi_door_ids: [] } })
    const res = await POST(postReq(validBody()))
    expect(res.status).toBe(403)
    expect(remoteUnlockDoor).not.toHaveBeenCalled()
  })
})

describe('POST /api/studio-management/unlock — preserved UniFi behaviour', () => {
  it('404s when the location row is missing', async () => {
    getCurrentUser.mockResolvedValue(manager)
    mockDb({ location: null })
    const res = await POST(postReq(validBody()))
    const body = await res.json()
    expect(res.status).toBe(404)
    expect(body).toEqual({ success: false, error: 'Location not found.' })
    expect(remoteUnlockDoor).not.toHaveBeenCalled()
  })

  it('412s with code unifi_not_configured when the location has no UniFi config', async () => {
    getCurrentUser.mockResolvedValue(manager)
    getUnifiConfig.mockResolvedValue({ configured: false })
    const res = await POST(postReq(validBody()))
    const body = await res.json()
    expect(res.status).toBe(412)
    expect(body).toEqual({
      success: false,
      error: 'UniFi Access is not fully configured for this location.',
      code: 'unifi_not_configured',
    })
    expect(remoteUnlockDoor).not.toHaveBeenCalled()
  })

  it('happy path: 200 and calls remoteUnlockDoor with the cfg, door id and CRM actor it builds', async () => {
    getCurrentUser.mockResolvedValue(manager)
    const res = await POST(postReq(validBody()))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body).toEqual({ success: true })
    expect(remoteUnlockDoor).toHaveBeenCalledWith(
      CFG, 'door-1', { actorId: 'u1', actorName: 'Ren Manager' }
    )
  })

  it('falls back to email for the UniFi actor name when there is no full name', async () => {
    getCurrentUser.mockResolvedValue({ ...manager, full_name: undefined })
    await POST(postReq(validBody()))
    expect(remoteUnlockDoor).toHaveBeenCalledWith(
      CFG, 'door-1', { actorId: 'u1', actorName: 'ren@x.test' }
    )
  })

  it('writes the timeline activity row with the door name and location', async () => {
    getCurrentUser.mockResolvedValue(manager)
    const db = mockDb()
    await POST(postReq(validBody({ door_name: 'Front Door' })))
    expect(db.activities).toEqual([{
      kind: 'event',
      type: 'door_unlock',
      title: 'Unlocked Front Door at Stillorgan',
      profile_id: 'u1',
      location_id: LOC,
    }])
  })

  it('surfaces a UnifiError with its own status', async () => {
    getCurrentUser.mockResolvedValue(manager)
    const err = new UnifiError('Door is offline')
    err.status = 503
    remoteUnlockDoor.mockRejectedValue(err)
    const res = await POST(postReq(validBody()))
    const body = await res.json()
    expect(res.status).toBe(503)
    expect(body).toEqual({ success: false, error: 'Door is offline' })
  })

  it('502s on a non-UniFi failure', async () => {
    getCurrentUser.mockResolvedValue(manager)
    remoteUnlockDoor.mockRejectedValue(new Error('socket hang up'))
    const res = await POST(postReq(validBody()))
    const body = await res.json()
    expect(res.status).toBe(502)
    expect(body).toEqual({ success: false, error: 'UniFi request failed: socket hang up' })
  })
})

// WIDGET.1 — audit attribution. The operator chose, against a flagged
// concern, that the widget's door button fires straight from the home
// screen. The third compensating control is that every unlock is legible
// after the fact as "opened via a widget from this device" — and the token
// id is what makes that device revocable on its own.
//
// NOTE: this route had NO logAuditEvent call before this task (it wrote
// only the best-effort `activities` timeline row, which carries no JSONB
// details column to hang `via` off). So there was no existing category or
// action to preserve; 'business' + 'door.unlocked' is new, chosen to match
// the neighbouring physical-studio actions ('studio_device.paired',
// 'ac.external_auto_off') which are also category 'business'.
describe('POST /api/studio-management/unlock — audit attribution', () => {
  it('records how the door was opened, and which widget did it', async () => {
    getCurrentUser.mockResolvedValue({
      ...manager, authSource: 'widget', widgetTokenId: 'tok-1',
    })
    const res = await POST(postReq(validBody({ door_name: 'Front Door' })))
    expect(res.status).toBe(200)
    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      details: expect.objectContaining({ via: 'widget', widget_token_id: 'tok-1' }),
    }))
  })

  it('marks an app unlock as via: app', async () => {
    getCurrentUser.mockResolvedValue(manager)
    const res = await POST(postReq(validBody()))
    expect(res.status).toBe(200)
    const last = logAuditEvent.mock.calls.at(-1)[0]
    expect(last.details.via).toBe('app')
    expect(last.details.widget_token_id).toBeUndefined()
  })

  it('scopes the audit row to the actor, the door and the location', async () => {
    getCurrentUser.mockResolvedValue(manager)
    await POST(postReq(validBody({ door_name: 'Front Door' })))
    const last = logAuditEvent.mock.calls.at(-1)[0]
    expect(last.category).toBe('business')
    expect(last.action).toBe('door.unlocked')
    expect(last.actor).toEqual({ id: 'u1', full_name: 'Ren Manager', email: 'ren@x.test' })
    // A door is not a profile — target.id is an FK to profiles, so the
    // door's identity goes in `resource` or the insert silently drops.
    expect(last.target).toEqual({ label: 'Front Door', resource: 'doors/door-1' })
    expect(last.locationId).toBe(LOC)
    expect(last.details).toMatchObject({ door_id: 'door-1', door_name: 'Front Door' })
  })

  it('does not write an audit row when the door never opened', async () => {
    getCurrentUser.mockResolvedValue(manager)
    remoteUnlockDoor.mockRejectedValue(new Error('socket hang up'))
    const res = await POST(postReq(validBody()))
    expect(res.status).toBe(502)
    expect(logAuditEvent).not.toHaveBeenCalled()
  })
})

// WIDGET.1 — Step 8: proves allowWidgetToken:true is actually WIRED, not
// merely declared. No session at all; a widget token resolves to a user
// holding studio_management at a location, and that user opens the door.
describe('POST /api/studio-management/unlock — widget-token path', () => {
  const widgetManager = {
    id: 'u9', role: 'manager', activeLocation: { id: LOC },
    full_name: 'Ren Manager', email: 'ren@x.test',
    authSource: 'widget', widgetTokenId: 'tok-9',
  }

  it('200s for a valid widget token with no session, and opens the door', async () => {
    getCurrentUser.mockResolvedValue(null)
    getWidgetUser.mockResolvedValue(widgetManager)
    const res = await POST(postReq(validBody()))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body).toEqual({ success: true })
    expect(remoteUnlockDoor).toHaveBeenCalledWith(
      CFG, 'door-1', { actorId: 'u9', actorName: 'Ren Manager' }
    )
    const last = logAuditEvent.mock.calls.at(-1)[0]
    expect(last.details.via).toBe('widget')
    expect(last.details.widget_token_id).toBe('tok-9')
  })

  it('does not consult a widget token when a session exists', async () => {
    getCurrentUser.mockResolvedValue(manager)
    const res = await POST(postReq(validBody()))
    expect(res.status).toBe(200)
    expect(getWidgetUser).not.toHaveBeenCalled()
  })

  // The token is location-scoped, but the permission is still re-checked
  // server-side on every call — a widget held by someone without
  // studio_management opens nothing.
  it('403s for a widget token whose user lacks studio_management', async () => {
    getCurrentUser.mockResolvedValue(null)
    getWidgetUser.mockResolvedValue({ ...widgetManager, role: 'staff' })
    const res = await POST(postReq(validBody()))
    expect(res.status).toBe(403)
    expect(remoteUnlockDoor).not.toHaveBeenCalled()
  })
})
