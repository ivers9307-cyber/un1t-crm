// FLEET-CMD.3 — GET /api/admin/fleet/screenshot/[id] through the real withAuth
// wrapper: fleet_admin at the device's studio (or master), else a 404.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../../../tests/helpers/fake-db.js'
import { person, MASTER, LOC_A, LOC_B } from '../../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logWarn: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { GET } = await import('./route.js')

const CMD = 'c0000000-0000-4000-8000-000000000001'
let db
let signed
const get = () => GET(new Request(`http://localhost/api/admin/fleet/screenshot/${CMD}`), { params: Promise.resolve({ id: CMD }) })
const admin = (on) => person({ [LOC_A]: { role: 'staff', permissions: { fleet_admin: on } }, [LOC_B]: { role: 'staff', permissions: { fleet_admin: true } } }, LOC_B)

beforeEach(() => {
  vi.clearAllMocks()
  db = createFakeDb({ tables: {
    fleet_devices: [{ device_name: 'pi-1', location_id: LOC_A }],
    fleet_commands: [{ id: CMD, device_name: 'pi-1', screenshot_path: 'pi-1/shot.png' }],
  } })
  signed = { data: { signedUrl: 'https://storage.example/signed' }, error: null }
  db.storage = { from: vi.fn(() => ({ createSignedUrl: vi.fn(async () => signed) })) }
  createServerClient.mockReturnValue(db)
})

describe('GET /api/admin/fleet/screenshot/[id]', () => {
  it('401 signed out', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await get()
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
  })

  it('404 without fleet_admin at the device’s studio, even with it at another', async () => {
    getCurrentUser.mockResolvedValue(admin(false))
    const res = await get()
    expect(res.status).toBe(404)
    expect(db.storage.from).not.toHaveBeenCalled()
  })

  it('a fleet admin at the device’s studio gets a signed link', async () => {
    getCurrentUser.mockResolvedValue(admin(true))
    const res = await get()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, url: 'https://storage.example/signed' })
  })

  it('a master is let through', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    expect((await get()).status).toBe(200)
  })
})
