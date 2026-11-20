// RCOV — POST /api/accounting/coverage/refresh through the real withAuth
// wrapper: accounting_hub at the active studio, the pull for that studio.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { person, LOC_A } from '../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', async (importOriginal) => ({ ...(await importOriginal()), createServerClient: vi.fn(() => ({})) }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))
vi.mock('@/lib/recon/pull', async (importOriginal) => ({ ...(await importOriginal()), runCoveragePull: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { runCoveragePull } = await import('@/lib/recon/pull')
const { POST } = await import('./route.js')

const hub = (on) => person({ [LOC_A]: { role: 'owner', permissions: { accounting_hub: on } } }, LOC_A)
const post = (body) => POST(new Request('http://localhost/api/accounting/coverage/refresh', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
}))

beforeEach(() => {
  vi.clearAllMocks()
  runCoveragePull.mockResolvedValue({ lines: 3 })
})

describe('POST /api/accounting/coverage/refresh', () => {
  it('401 signed out, nothing pulled', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await post()
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
    expect(runCoveragePull).not.toHaveBeenCalled()
  })

  it('403 "Forbidden" without accounting_hub, nothing pulled', async () => {
    getCurrentUser.mockResolvedValue(hub(false))
    const res = await post()
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ success: false, error: 'Forbidden' })
    expect(runCoveragePull).not.toHaveBeenCalled()
  })

  it('pulls the active studio, force passed through', async () => {
    getCurrentUser.mockResolvedValue(hub(true))
    const res = await post({ force: true })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: { lines: 3 } })
    expect(runCoveragePull).toHaveBeenCalledWith(expect.anything(), LOC_A, { trigger: 'manual', acceptMassCover: true })
  })

  it('an unexpected failure answers a fixed 502, never the error text', async () => {
    getCurrentUser.mockResolvedValue(hub(true))
    runCoveragePull.mockRejectedValue(new Error('recon run claim failed: connection refused'))
    const res = await post()
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ success: false, error: 'The coverage pull failed. Try again.' })
  })
})
