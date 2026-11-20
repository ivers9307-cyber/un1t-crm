// FLEET-CMD.1 — POST /api/admin/fleet/devices/[name]/token through the real
// withAuth wrapper: masters only, the raw token answered once.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../../../../tests/helpers/fake-db.js'
import { person, MASTER, LOC_A } from '../../../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logInfo: vi.fn(), logWarn: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { POST } = await import('./route.js')

let db
const post = (name = 'pi-1') => POST(new Request(`http://localhost/api/admin/fleet/devices/${name}/token`, { method: 'POST' }), { params: Promise.resolve({ name }) })

beforeEach(() => {
  vi.clearAllMocks()
  db = createFakeDb({ tables: { fleet_devices: [{ device_name: 'pi-1', location_id: LOC_A, api_token_hash: 'old' }] } })
  createServerClient.mockReturnValue(db)
})

describe('POST /api/admin/fleet/devices/[name]/token', () => {
  it('401 signed out', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await post()
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
    expect(db.tables.fleet_devices[0].api_token_hash).toBe('old')
  })

  it("403 'Master only' for an owner, nothing rotated", async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_A]: { role: 'owner' } }, LOC_A))
    const res = await post()
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ ok: false, error: 'Master only' })
    expect(db.tables.fleet_devices[0].api_token_hash).toBe('old')
  })

  it('a master rotates the token; only its hash is stored', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    const res = await post()
    expect(res.status).toBe(200)
    const { ok, token } = await res.json()
    expect(ok).toBe(true)
    expect(token).toMatch(/^fdv_/)
    expect(db.tables.fleet_devices[0].api_token_hash).not.toBe('old')
    expect(db.tables.fleet_devices[0].api_token_hash).not.toBe(token)
  })

  it('404 for an unknown device', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    expect((await post('nope')).status).toBe(404)
  })
})
