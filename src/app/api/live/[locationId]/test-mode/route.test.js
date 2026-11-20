// POST/DELETE /api/live/[locationId]/test-mode through the real withAuth
// wrapper (ROUTEWRAP.R6): owner/manager/head_coach AT the URL's studio with
// studio_management there; no database text on a failed write.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../../tests/helpers/fake-db.js'
import { person, LOC_A, LOC_B } from '../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn(), logInfo: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { POST, DELETE } = await import('./route.js')

const BRIDGE_A = 'b0000000-0000-4000-8000-00000000000a'
const BRIDGE_B = 'b0000000-0000-4000-8000-00000000000b'
let db
const props = (loc) => ({ params: Promise.resolve({ locationId: loc }) })
const on = (loc = LOC_A, body = { minutes: 30 }) => POST(new Request(`http://localhost/api/live/${loc}/test-mode`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), props(loc))
const off = (loc = LOC_A) => DELETE(new Request(`http://localhost/api/live/${loc}/test-mode`, { method: 'DELETE' }), props(loc))
const at = (role) => person({ [LOC_A]: { role, permissions: { studio_management: true } } }, LOC_A)
const bridge = (id) => db.tables.ble_bridges.find((b) => b.id === id)

beforeEach(() => {
  vi.clearAllMocks()
  db = createFakeDb({ tables: { ble_bridges: [
    { id: BRIDGE_A, location_id: LOC_A, test_mode_until: null },
    { id: BRIDGE_B, location_id: LOC_B, test_mode_until: null },
  ] } })
  createServerClient.mockReturnValue(db)
})

describe('/api/live/[locationId]/test-mode', () => {
  it('401 signed out, nothing written', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await on()).status).toBe(401)
    expect((await off()).status).toBe(401)
    expect(bridge(BRIDGE_A).test_mode_until).toBeNull()
  })

  it('403 "Coach only" for staff at the studio', async () => {
    getCurrentUser.mockResolvedValue(at('staff'))
    const res = await on()
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('Coach only')
    expect(bridge(BRIDGE_A).test_mode_until).toBeNull()
  })

  it("403 at a studio outside the caller's; the other studio's bridge is untouched", async () => {
    getCurrentUser.mockResolvedValue(at('owner'))
    expect((await on(LOC_B)).status).toBe(403)
    expect(bridge(BRIDGE_B).test_mode_until).toBeNull()
  })

  it('a head coach switches test mode on and off at their studio only', async () => {
    getCurrentUser.mockResolvedValue(at('head_coach'))
    const res = await on()
    expect(res.status).toBe(200)
    expect(bridge(BRIDGE_A).test_mode_until).toBe((await res.json()).test_mode_until)
    expect(bridge(BRIDGE_B).test_mode_until).toBeNull()
    expect((await off()).status).toBe(200)
    expect(bridge(BRIDGE_A).test_mode_until).toBeNull()
  })

  it('a failed write is a 500 with a fixed message', async () => {
    getCurrentUser.mockResolvedValue(at('owner'))
    db.errors.ble_bridges = { update: { code: '57014', message: 'canceling statement due to statement timeout' } }
    const res = await on()
    expect(res.status).toBe(500)
    expect((await res.json()).error).not.toMatch(/statement/)
  })
})
