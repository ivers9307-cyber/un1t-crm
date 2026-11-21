// GET /api/accounting/payables through the real withAuth wrapper: signed in
// (401), accounting_hub at the active studio (403), an active studio (400),
// then Xero. A Xero failure names its status, never Xero's own text.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { person, LOC_A } from '../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', async (importOriginal) => ({ ...(await importOriginal()), createServerClient: vi.fn(() => ({})) }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn(), logWarn: vi.fn() }))
vi.mock('@/lib/xero/client', async (importOriginal) => ({ ...(await importOriginal()), withFreshToken: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { withFreshToken, XeroError } = await import('@/lib/xero/client')
const { logError } = await import('@/lib/log')
const { GET } = await import('./route.js')

const HUB_A = person({ [LOC_A]: { role: 'owner', permissions: { accounting_hub: true } } }, LOC_A)
const NO_HUB_A = person({ [LOC_A]: { role: 'owner', permissions: { accounting_hub: false } } }, LOC_A)
const call = () => GET(new Request('http://localhost/api/accounting/payables'))

beforeEach(() => {
  vi.clearAllMocks()
  withFreshToken.mockResolvedValue({ xfetch: vi.fn(async () => ({ Invoices: [] })) })
})

describe('GET /api/accounting/payables', () => {
  it('401 signed out, Xero never called', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await call()
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
    expect(withFreshToken).not.toHaveBeenCalled()
  })

  it('403 without accounting_hub', async () => {
    getCurrentUser.mockResolvedValue(NO_HUB_A)
    const res = await call()
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ success: false, error: 'Forbidden' })
    expect(withFreshToken).not.toHaveBeenCalled()
  })

  it('400 without an active studio', async () => {
    getCurrentUser.mockResolvedValue({ ...HUB_A, activeLocation: null })
    const res = await call()
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ success: false, error: 'No active location' })
    expect(withFreshToken).not.toHaveBeenCalled()
  })

  it('reads the active studio’s bills', async () => {
    getCurrentUser.mockResolvedValue(HUB_A)
    const res = await call()
    expect(res.status).toBe(200)
    expect(withFreshToken).toHaveBeenCalledWith(LOC_A)
  })

  it('a Xero failure is a 502 with its status, never Xero’s text', async () => {
    getCurrentUser.mockResolvedValue(HUB_A)
    withFreshToken.mockResolvedValue({ xfetch: vi.fn(async () => { throw new XeroError('Validation: tenant 1234 has no invoices scope', { status: 400 }) }) })
    const res = await call()
    expect(res.status).toBe(502)
    const body = await res.json()
    expect(body.error).toMatch(/^Xero error \(400\)\./)
    expect(JSON.stringify(body)).not.toContain('tenant 1234')
    expect(logError).toHaveBeenCalled()
  })
})
