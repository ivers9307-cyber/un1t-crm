// FEES.1 — POST /api/class-fees/retry through the real withAuth wrapper. The
// hand-written checks run in their old order: body 400, studio membership 403,
// class_fees at the body's studio 403, then the per-member rate limit 429.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { person, LOC_A, LOC_B, LOC_OTHER } from '../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({ tag: 'db' })) }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))
vi.mock('@/lib/class-fees-run', () => ({ retryContactFees: vi.fn() }))
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { retryContactFees } = await import('@/lib/class-fees-run')
const { checkRateLimit } = await import('@/lib/rate-limit')
const { POST } = await import('./route.js')

const CONTACT = 'c0000000-0000-4000-8000-0000000000c1'
const post = (body) => POST(new Request('http://localhost/api/class-fees/retry', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }))
const keyAt = (a, b) => person({ [LOC_A]: { role: 'owner', permissions: { class_fees: a } }, [LOC_B]: { role: 'owner', permissions: { class_fees: b } } }, LOC_A)

beforeEach(() => {
  vi.clearAllMocks()
  checkRateLimit.mockResolvedValue({ allowed: true })
  retryContactFees.mockResolvedValue({ outcomes: [{ feeId: 'f1', outcome: 'charged' }] })
})

describe('POST /api/class-fees/retry', () => {
  it('401 signed out, nothing charged', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await post({ location_id: LOC_B, contact_id: CONTACT })).status).toBe(401)
    expect(retryContactFees).not.toHaveBeenCalled()
  })

  it('400 without a contact_id', async () => {
    getCurrentUser.mockResolvedValue(keyAt(true, true))
    expect((await post({ location_id: LOC_B })).status).toBe(400)
  })

  it('403 for a studio the caller is not in; 403 "Forbidden" without class_fees there; no rate-limit slot taken', async () => {
    getCurrentUser.mockResolvedValue(keyAt(true, true))
    expect((await post({ location_id: LOC_OTHER, contact_id: CONTACT })).status).toBe(403)
    getCurrentUser.mockResolvedValue(keyAt(true, false))
    const res = await post({ location_id: LOC_B, contact_id: CONTACT })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ success: false, error: 'Forbidden' })
    expect(checkRateLimit).not.toHaveBeenCalled()
    expect(retryContactFees).not.toHaveBeenCalled()
  })

  it('429 when a retry for this member just ran', async () => {
    getCurrentUser.mockResolvedValue(keyAt(false, true))
    checkRateLimit.mockResolvedValue({ allowed: false })
    expect((await post({ location_id: LOC_B, contact_id: CONTACT })).status).toBe(429)
    expect(retryContactFees).not.toHaveBeenCalled()
  })

  it('an allowed caller retries at the body\'s studio', async () => {
    getCurrentUser.mockResolvedValue(keyAt(false, true))
    const res = await post({ location_id: LOC_B, contact_id: CONTACT })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: { outcomes: [{ feeId: 'f1', outcome: 'charged' }] } })
    expect(checkRateLimit).toHaveBeenCalledWith({ tag: 'db' }, `class-fees-retry:${LOC_B}:${CONTACT}`, { max: 3, windowMs: 60_000 })
    expect(retryContactFees).toHaveBeenCalledWith({ tag: 'db' }, { locationId: LOC_B, contactId: CONTACT, actor: { id: 'user-1' } })
  })
})
