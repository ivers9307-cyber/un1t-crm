// src/app/api/sonos/control/route.test.js
// WIDGET.1 — characterisation tests written BEFORE migrating this route
// from its hand-rolled getCurrentUser()/hasPermission() preamble to
// withAuth. These pin down what the route does TODAY (status codes, error
// bodies, and exactly what runLiveAction is called with) so the migration
// to withAuth — and the widget-token opt-in that follows — cannot silently
// change an auth outcome or which studio a command targets.
//
// Permission key: 'device_control'. Location: user.activeLocation?.id.
// Sonos client seam: runLiveAction (src/lib/sonos/live.js) — mocked here,
// its own behaviour is tested in src/lib/sonos/live.test.js.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/widget-auth', () => ({ getWidgetUser: vi.fn() }))
vi.mock('@/lib/sonos/live', () => ({ runLiveAction: vi.fn() }))

import { POST } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { getWidgetUser } from '@/lib/widget-auth'
import { runLiveAction } from '@/lib/sonos/live'

const LOC = 'loc1'
const VALID_SCHEDULE_ID = 'a0000000-0000-0000-0000-000000000001'

// device_control defaults to true for manager/owner, false for staff
// (shared/permissions.js DEFAULT_WEB_PERMISSIONS_BY_ROLE) — real
// hasPermission runs here, not a mock.
const manager = { id: 'u1', role: 'manager', activeLocation: { id: LOC } }
const staffNoPerm = { id: 'u2', role: 'staff', activeLocation: { id: LOC } }
const managerNoLocation = { id: 'u3', role: 'manager', activeLocation: null }
const widgetManager = {
  id: 'u4', role: 'manager', authSource: 'widget', activeLocation: { id: LOC },
}

function postReq(body) {
  return new Request('http://x/api/sonos/control', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
}
const validBody = (overrides = {}) => ({ schedule_id: VALID_SCHEDULE_ID, action: 'play', ...overrides })

beforeEach(() => {
  vi.clearAllMocks()
  createServerClient.mockReturnValue({ marker: 'db' })
})

describe('POST /api/sonos/control', () => {
  it('401s when unauthenticated (no session, no widget token)', async () => {
    getCurrentUser.mockResolvedValue(null)
    getWidgetUser.mockResolvedValue(null)
    const res = await POST(postReq(validBody()))
    const body = await res.json()
    expect(res.status).toBe(401)
    expect(body).toEqual({ success: false, error: 'Unauthorized' })
    expect(runLiveAction).not.toHaveBeenCalled()
  })

  // Step 6 — proves the allowWidgetToken:true opt-in is actually wired,
  // not just declared: no session, but a widget token resolving to a user
  // holding device_control at a location reaches the same happy path a
  // session user would.
  it('200s for a valid widget token with no session, and calls runLiveAction the same as a session would', async () => {
    getCurrentUser.mockResolvedValue(null)
    getWidgetUser.mockResolvedValue(widgetManager)
    runLiveAction.mockResolvedValue({ ok: true, groups: [{ id: 'g1' }] })
    const res = await POST(postReq(validBody()))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body).toEqual({ success: true, groups: [{ id: 'g1' }] })
    expect(runLiveAction).toHaveBeenCalledWith(
      { marker: 'db' }, LOC, { scheduleId: VALID_SCHEDULE_ID }, 'play', undefined
    )
  })

  it('does not consult a widget token when a session exists', async () => {
    getCurrentUser.mockResolvedValue(manager)
    runLiveAction.mockResolvedValue({ ok: true, groups: [] })
    const res = await POST(postReq(validBody()))
    expect(res.status).toBe(200)
    expect(getWidgetUser).not.toHaveBeenCalled()
  })

  // WIDGET.1 — migrated to withAuth. The status code (403) is the pinned
  // behaviour; the exact wording is now withAuth's standardised
  // AUTH_ERRORS.forbidden() text (src/lib/with-auth.js), not the
  // hand-rolled preamble's bare 'Forbidden'. That's the whole point of the
  // wrapper — see its header comment on message-text drift across routes.
  it('403s when authenticated but lacking device_control', async () => {
    getCurrentUser.mockResolvedValue(staffNoPerm)
    const res = await POST(postReq(validBody()))
    const body = await res.json()
    expect(res.status).toBe(403)
    expect(body).toEqual({
      success: false,
      error: 'Device control is not enabled for your role at this location.',
    })
    expect(runLiveAction).not.toHaveBeenCalled()
  })

  // WIDGET.1 — same note: status code (400) is pinned, wording is now
  // withAuth's AUTH_ERRORS.noActiveLocation() ('No active location.' with
  // a trailing period) rather than the preamble's 'No active location'.
  it('400s when authenticated and permitted but there is no active location', async () => {
    getCurrentUser.mockResolvedValue(managerNoLocation)
    const res = await POST(postReq(validBody()))
    const body = await res.json()
    expect(res.status).toBe(400)
    expect(body).toEqual({ success: false, error: 'No active location.' })
    expect(runLiveAction).not.toHaveBeenCalled()
  })

  it('400s on a body that fails the zod schema (neither schedule_id nor group_id)', async () => {
    getCurrentUser.mockResolvedValue(manager)
    const res = await POST(postReq({ action: 'play' }))
    const body = await res.json()
    expect(res.status).toBe(400)
    expect(body).toEqual({ success: false, error: 'Invalid request' })
    expect(runLiveAction).not.toHaveBeenCalled()
  })

  it('404s when schedule_id is not uuid-shaped', async () => {
    getCurrentUser.mockResolvedValue(manager)
    const res = await POST(postReq(validBody({ schedule_id: 'not-a-uuid' })))
    const body = await res.json()
    expect(res.status).toBe(404)
    expect(body).toEqual({ success: false, error: 'Not found' })
    expect(runLiveAction).not.toHaveBeenCalled()
  })

  it('happy path: 200 and calls runLiveAction with the db, locationId, target, action and value the route builds', async () => {
    getCurrentUser.mockResolvedValue(manager)
    runLiveAction.mockResolvedValue({ ok: true, groups: [{ id: 'g1' }] })
    const res = await POST(postReq(validBody()))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body).toEqual({ success: true, groups: [{ id: 'g1' }] })
    expect(runLiveAction).toHaveBeenCalledWith(
      { marker: 'db' }, LOC, { scheduleId: VALID_SCHEDULE_ID }, 'play', undefined
    )
  })

  it('addresses by group_id instead of schedule_id when the body carries one', async () => {
    getCurrentUser.mockResolvedValue(manager)
    runLiveAction.mockResolvedValue({ ok: true, groups: [] })
    const res = await POST(postReq({ group_id: 'RINCON_123:4', action: 'pause' }))
    expect(res.status).toBe(200)
    expect(runLiveAction).toHaveBeenCalledWith(
      { marker: 'db' }, LOC, { groupId: 'RINCON_123:4' }, 'pause', undefined
    )
  })

  it('passes value through for set_volume', async () => {
    getCurrentUser.mockResolvedValue(manager)
    runLiveAction.mockResolvedValue({ ok: true, groups: [] })
    const res = await POST(postReq(validBody({ action: 'set_volume', value: 30 })))
    expect(res.status).toBe(200)
    expect(runLiveAction).toHaveBeenCalledWith(
      { marker: 'db' }, LOC, { scheduleId: VALID_SCHEDULE_ID }, 'set_volume', 30
    )
  })

  it('maps a non-ok outcome to its OUTCOME status/message and forwards applied/failedGroups', async () => {
    getCurrentUser.mockResolvedValue(manager)
    runLiveAction.mockResolvedValue({
      ok: false, code: 'rate_limited', applied: ['g1'], failedGroups: ['g2'],
    })
    const res = await POST(postReq(validBody({ action: 'volume_up' })))
    const body = await res.json()
    expect(res.status).toBe(429)
    expect(body).toEqual({
      success: false,
      error: 'Too many changes at once — give it a moment',
      code: 'rate_limited',
      applied: ['g1'],
      failedGroups: ['g2'],
    })
  })

  it('falls back to 502 "That did not work" for a code not in the OUTCOME table', async () => {
    getCurrentUser.mockResolvedValue(manager)
    runLiveAction.mockResolvedValue({ ok: false, code: 'totally_unknown' })
    const res = await POST(postReq(validBody()))
    const body = await res.json()
    expect(res.status).toBe(502)
    expect(body).toEqual({ success: false, error: 'That did not work', code: 'totally_unknown' })
  })
})
