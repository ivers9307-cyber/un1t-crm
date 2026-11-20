// ROUTEWRAP.R10 — POST /api/automations/[key]/run-now through the real withAuth
// wrapper: signed out is the wrapper's 401 (it was a 403), Manager+ is judged
// at the body's studio, and the runner acts on that studio only.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { person, LOC_A, LOC_B } from '../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({ tag: 'db' })) }))
vi.mock('@/lib/glofox', async (importOriginal) => ({
  ...(await importOriginal()),
  glofoxCredentialsForLocation: vi.fn(async () => ({})),
  missingGlofoxCredentialsForLocation: vi.fn(() => ['api_key']),
}))
vi.mock('@/lib/class-occurrences', () => ({ syncOccurrencesForLocation: vi.fn() }))
vi.mock('@/lib/class-climate-runner', () => ({ runClassClimate: vi.fn(async () => ({ locations: [{ planned: ['p'], actions: [], errors: [] }] })) }))
vi.mock('@/lib/bathroom-climate-runner', () => ({ runBathroomClimate: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { runClassClimate } = await import('@/lib/class-climate-runner')
const { POST } = await import('./route.js')

const post = (key, body) => POST(new Request(`http://localhost/api/automations/${key}/run-now`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}), { params: Promise.resolve({ key }) })
const two = (roleA, roleB) => person({ [LOC_A]: { role: roleA }, [LOC_B]: { role: roleB } }, LOC_A)

beforeEach(() => vi.clearAllMocks())

describe('POST /api/automations/[key]/run-now', () => {
  it('401 signed out', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await post('class_climate', { location_id: LOC_A })
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
  })

  it('403 for staff everywhere, and at a studio where they are staff', async () => {
    getCurrentUser.mockResolvedValue(two('staff', 'staff'))
    expect((await post('class_climate', { location_id: LOC_A })).status).toBe(403)
    getCurrentUser.mockResolvedValue(two('manager', 'staff'))
    expect((await post('class_climate', { location_id: LOC_B })).status).toBe(403)
    expect(runClassClimate).not.toHaveBeenCalled()
  })

  it('400 for an unsupported key', async () => {
    getCurrentUser.mockResolvedValue(two('manager', 'staff'))
    expect((await post('nope', { location_id: LOC_A })).status).toBe(400)
  })

  it('runs the check at the caller’s studio', async () => {
    getCurrentUser.mockResolvedValue(two('manager', 'staff'))
    const res = await post('class_climate', { location_id: LOC_A, dry_run: true })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ success: true, glofox_configured: false, planned: ['p'] })
    expect(runClassClimate).toHaveBeenCalledWith({ tag: 'db' }, { locationId: LOC_A, dryRun: true })
  })
})
