// POST /api/admin/bridges/[id]/rotate-token through the real withAuth wrapper.
// Masters only, checked in the handler so the 403 keeps its { ok: false } shape;
// the old hash moves to the grace slot and the new raw token is shown once.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../../../tests/helpers/fake-db.js'
import { person, MASTER, LOC_A } from '../../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { POST } = await import('./route.js')

const BRIDGE = 'e7000000-0000-4000-8000-000000000001'
const post = (id = BRIDGE) => POST(new Request(`http://localhost/api/admin/bridges/${id}/rotate-token`, { method: 'POST' }), { params: Promise.resolve({ id }) })
let db

beforeEach(() => {
  vi.clearAllMocks()
  db = createFakeDb({ tables: { ble_bridges: [{ id: BRIDGE, name: 'Pi 1', hardware_id: 'hw-1', location_id: LOC_A, api_token_hash: 'old-hash' }] } })
  createServerClient.mockReturnValue(db)
})

describe('POST /api/admin/bridges/[id]/rotate-token', () => {
  it('401 signed out (withAuth), nothing rotated', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await post()
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
    expect(db.tables.ble_bridges[0].api_token_hash).toBe('old-hash')
  })

  it('403 "Master only" for an owner, nothing rotated', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_A]: { role: 'owner' } }, LOC_A))
    const res = await post()
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ ok: false, error: 'Master only' })
    expect(db.tables.ble_bridges[0].api_token_hash).toBe('old-hash')
  })

  it('404 for an unknown bridge', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    expect((await post('e7000000-0000-4000-8000-000000000009')).status).toBe(404)
  })

  it('a master rotates: the old hash moves to the grace slot', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    const res = await post()
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.ok).toBe(true)
    expect(typeof json.token).toBe('string')
    expect(json.bridge).toEqual({ id: BRIDGE, name: 'Pi 1', hardware_id: 'hw-1', location_id: LOC_A })
    const row = db.tables.ble_bridges[0]
    expect(row.previous_token_hash).toBe('old-hash')
    expect(row.api_token_hash).not.toBe('old-hash')
  })

  it('a failed read is a 400 without the database text', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    createServerClient.mockReturnValue(createFakeDb({ tables: { ble_bridges: [] }, errors: { ble_bridges: { select: { message: 'secret detail' } } } }))
    const res = await post()
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ ok: false, error: 'rotate_failed' })
  })
})
