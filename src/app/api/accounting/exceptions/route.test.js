// RCOV.P2 — GET /api/accounting/exceptions through the real withAuth wrapper:
// accounting_hub at the active studio; findings for that studio only.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { person, LOC_A, LOC_B } from '../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({ tag: 'db' })) }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))
vi.mock('@/lib/recon/exceptions', () => ({ getExceptions: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { getExceptions } = await import('@/lib/recon/exceptions')
const { GET } = await import('./route.js')

const get = () => GET(new Request('http://localhost/api/accounting/exceptions'))

beforeEach(() => {
  vi.clearAllMocks()
  getExceptions.mockResolvedValue({ findings: [] })
})

describe('GET /api/accounting/exceptions', () => {
  it('401 signed out', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await get()).status).toBe(401)
  })

  it('403 for a manager at the active studio, even one who owns another studio', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_A]: { role: 'manager' }, [LOC_B]: { role: 'owner' } }, LOC_A))
    expect((await get()).status).toBe(403)
    expect(getExceptions).not.toHaveBeenCalled()
  })

  it('an owner gets the active studio findings', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_A]: { role: 'owner' } }, LOC_A))
    const res = await get()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: { findings: [] } })
    expect(getExceptions).toHaveBeenCalledWith({ tag: 'db' }, LOC_A)
  })

  it('a failed detection is a 500 without the error text', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_A]: { role: 'owner' } }, LOC_A))
    getExceptions.mockRejectedValue(new Error('relation secret_table does not exist'))
    const res = await get()
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('secret_table')
  })
})
