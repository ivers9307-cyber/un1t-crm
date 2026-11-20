// SONOS.11 — GET /api/sonos/connect through the real withAuth wrapper:
// device_control at the active studio, then a redirect carrying a signed state
// for that studio.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { person, LOC_A, LOC_B } from '../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({})) }))
vi.mock('@/lib/sonos/client', async (importOriginal) => ({
  ...(await importOriginal()),
  getSonosConfig: vi.fn(() => ({ clientId: 'c' })),
  buildAuthorizeUrl: vi.fn((_cfg, state) => `https://api.sonos.example/auth?state=${state}`),
}))

const { getCurrentUser } = await import('@/lib/auth')
const { GET, verifyState } = await import('./route.js')

const get = () => GET(new Request('http://localhost/api/sonos/connect'))
const caller = (on, active = LOC_A) => person({ [LOC_A]: { role: 'staff', permissions: { device_control: on } }, [LOC_B]: { role: 'staff', permissions: { device_control: true } } }, active)

beforeEach(() => { vi.clearAllMocks(); vi.stubEnv('CRON_SECRET', 'test-secret') })
afterEach(() => { vi.unstubAllEnvs() })

describe('GET /api/sonos/connect', () => {
  it('401 JSON signed out, never a redirect', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await get()
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
  })

  it("403 'Forbidden' without device_control at the active studio", async () => {
    getCurrentUser.mockResolvedValue(caller(false))
    const res = await get()
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ success: false, error: 'Forbidden' })
  })

  it('redirects with a state signed for the active studio', async () => {
    getCurrentUser.mockResolvedValue(caller(true))
    const res = await get()
    expect(res.status).toBe(307)
    const state = new URL(res.headers.get('location')).searchParams.get('state')
    expect(verifyState(state, 'test-secret')).toMatchObject({ locationId: LOC_A, profileId: 'user-1' })
  })
})
