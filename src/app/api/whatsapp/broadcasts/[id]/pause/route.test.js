// ROUTEWRAP.R9 — POST /api/whatsapp/broadcasts/[id]/pause on withAuth: the
// sign-in moved into the wrapper, every gate after it is the route's own
// (whatsapp somewhere → broadcast read → 404 off-studio → whatsapp there).
// Fictional ids only: the repo is public.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', async (importOriginal) => ({ ...(await importOriginal()), createServerClient: vi.fn() }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))
vi.mock('@/lib/permissions', async (importOriginal) => ({
  ...(await importOriginal()),
  hasPermissionAtAnyLocation: vi.fn(() => true),
  hasPermissionForLocation: vi.fn(() => true),
}))
vi.mock('@/lib/whatsapp-blast-signoff', () => ({ routeSignoffFor: vi.fn(async () => ({ blocked: null, stamp: null })) }))

import { POST } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { logError } from '@/lib/log'
import { hasPermissionAtAnyLocation, hasPermissionForLocation } from '@/lib/permissions'
import { routeSignoffFor } from '@/lib/whatsapp-blast-signoff'
import { createFakeDb } from '../../../../../../../tests/helpers/fake-db.js'
import { LOC_A, LOC_B, person } from '../../../../../../../tests/helpers/owner-at-location-callers.js'

const BID = 'c0000000-0000-4000-8000-0000000000b1'
const req = (body) => new Request(`http://localhost/api/whatsapp/broadcasts/${BID}/pause`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})
const call = (body) => POST(req(body), { params: Promise.resolve({ id: BID }) })

let db
beforeEach(() => {
  vi.clearAllMocks()
  hasPermissionAtAnyLocation.mockReturnValue(true)
  hasPermissionForLocation.mockReturnValue(true)
  getCurrentUser.mockResolvedValue(person({ [LOC_A]: 'manager' }, LOC_A))
  db = createFakeDb({ tables: { whatsapp_broadcasts: [{ id: BID, location_id: LOC_A, name: 'Drip', signed_off_by: null, paused_at: null }] } })
  createServerClient.mockReturnValue(db)
})

describe('POST /api/whatsapp/broadcasts/[id]/pause', () => {
  it('signed out: withAuth 401, nothing read', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await call({ paused: true })
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
    expect(createServerClient).not.toHaveBeenCalled()
  })

  it('no whatsapp anywhere: 403 before the row is read', async () => {
    hasPermissionAtAnyLocation.mockReturnValue(false)
    const res = await call({ paused: true })
    expect(res.status).toBe(403)
    expect(db.calls).toEqual([])
  })

  it("another studio's broadcast: 404, nothing written", async () => {
    db.tables.whatsapp_broadcasts[0].location_id = LOC_B
    const res = await call({ paused: true })
    expect(res.status).toBe(404)
    expect(db.tables.whatsapp_broadcasts[0].paused_at).toBeNull()
  })

  it('whatsapp not held at the broadcast\'s studio: 403', async () => {
    hasPermissionForLocation.mockReturnValue(false)
    const res = await call({ paused: true })
    expect(res.status).toBe(403)
    expect(hasPermissionForLocation).toHaveBeenCalledWith(expect.anything(), LOC_A, 'whatsapp')
  })

  it('pauses (no sign-off check) and resumes (sign-off checked)', async () => {
    const paused = await call({ paused: true })
    expect(paused.status).toBe(200)
    expect((await paused.json()).broadcast.paused_at).toBeTruthy()
    expect(routeSignoffFor).not.toHaveBeenCalled()
    const resumed = await call({ paused: false })
    expect(resumed.status).toBe(200)
    expect((await resumed.json()).broadcast.paused_at).toBeNull()
    expect(routeSignoffFor).toHaveBeenCalledTimes(1)
  })

  it('a failed write answers a fixed line, the database text logged', async () => {
    db = createFakeDb({
      tables: { whatsapp_broadcasts: [{ id: BID, location_id: LOC_A, name: 'Drip' }] },
      errors: { whatsapp_broadcasts: { update: { message: 'secret db text' } } },
    })
    createServerClient.mockReturnValue(db)
    const res = await call({ paused: true })
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toBe('Could not update the broadcast. Try again.')
    expect(JSON.stringify(body)).not.toContain('secret db text')
    expect(logError).toHaveBeenCalled()
  })
})
