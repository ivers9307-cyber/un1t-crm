// RCOV — GET /api/accounting/coverage/accounts through the real withAuth
// wrapper: accounting_hub at the active studio, Xero read for that studio.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { person, LOC_A } from '../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({})) }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))
vi.mock('@/lib/xero/client', async (importOriginal) => ({ ...(await importOriginal()), withFreshToken: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { withFreshToken, XeroError } = await import('@/lib/xero/client')
const { GET } = await import('./route.js')

const hub = (on) => person({ [LOC_A]: { role: 'owner', permissions: { accounting_hub: on } } }, LOC_A)
const xfetch = vi.fn(async () => ({ Accounts: [
  { AccountID: 'x1', Name: 'Current', Status: 'ACTIVE' },
  { AccountID: 'x2', Name: 'Old', Status: 'ARCHIVED' },
] }))

beforeEach(() => {
  vi.clearAllMocks()
  withFreshToken.mockResolvedValue({ xfetch })
})

describe('GET /api/accounting/coverage/accounts', () => {
  it('401 signed out', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await GET(new Request('http://localhost/api/accounting/coverage/accounts'))
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
  })

  it('403 "Forbidden" without accounting_hub, Xero never called', async () => {
    getCurrentUser.mockResolvedValue(hub(false))
    const res = await GET(new Request('http://localhost/api/accounting/coverage/accounts'))
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ success: false, error: 'Forbidden' })
    expect(withFreshToken).not.toHaveBeenCalled()
  })

  it('lists the active BANK accounts of the active studio’s Xero', async () => {
    getCurrentUser.mockResolvedValue(hub(true))
    const res = await GET(new Request('http://localhost/api/accounting/coverage/accounts'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: { accounts: [{ id: 'x1', name: 'Current' }] } })
    expect(withFreshToken).toHaveBeenCalledWith(LOC_A)
  })

  it('409 when Xero is not connected', async () => {
    getCurrentUser.mockResolvedValue(hub(true))
    withFreshToken.mockRejectedValue(new XeroError('no token'))
    expect((await GET(new Request('http://localhost/api/accounting/coverage/accounts'))).status).toBe(409)
  })
})
