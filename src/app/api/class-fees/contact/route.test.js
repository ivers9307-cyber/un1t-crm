// FEES.1 — GET /api/class-fees/contact through the real withAuth wrapper:
// class_fees at the query's studio, the fees read for that studio.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { person, LOC_A, LOC_B } from '../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({ tag: 'db' })) }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))
vi.mock('@/lib/class-fees-run', () => ({ contactOpenFees: vi.fn() }))
vi.mock('@/lib/class-fees-exemptions', () => ({ exemptContactIds: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { contactOpenFees } = await import('@/lib/class-fees-run')
const { exemptContactIds } = await import('@/lib/class-fees-exemptions')
const { GET } = await import('./route.js')

const CONTACT = 'c0000000-0000-4000-8000-0000000000c1'
const get = (loc = LOC_A) => GET(new Request(`http://localhost/api/class-fees/contact?location_id=${loc}&contact_id=${CONTACT}`))
const fees = (on) => person({ [LOC_A]: { role: 'manager', permissions: { class_fees: on } } }, LOC_A)

beforeEach(() => {
  vi.clearAllMocks()
  contactOpenFees.mockResolvedValue([
    { id: 'f1', status: 'outstanding', amount_cents: 500 },
    { id: 'f2', status: 'appealed', amount_cents: 700 },
  ])
  exemptContactIds.mockResolvedValue(new Set())
})

describe('GET /api/class-fees/contact', () => {
  it('401 signed out', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await get()
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
  })

  it('403 for a studio outside the caller’s, nothing read', async () => {
    getCurrentUser.mockResolvedValue(fees(true))
    const res = await get(LOC_B)
    expect(res.status).toBe(403)
    expect(contactOpenFees).not.toHaveBeenCalled()
  })

  it('403 "Forbidden" without class_fees there', async () => {
    getCurrentUser.mockResolvedValue(fees(false))
    const res = await get()
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ success: false, error: 'Forbidden' })
  })

  it('the member’s fees at that studio, with what is owed', async () => {
    getCurrentUser.mockResolvedValue(fees(true))
    const res = await get()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ success: true, data: { exempt: false, owed_cents: 500 } })
    expect(contactOpenFees).toHaveBeenCalledWith({ tag: 'db' }, { locationId: LOC_A, contactId: CONTACT })
  })
})
