// HOST-PORTAL.8 / ORGROLE.1 — GET /api/accounting/event-fees through the real
// withAuth wrapper: an organisation admin of the ACTIVE organisation; the
// fees are read for that organisation only. (tests/role-sweep/orgrole-routes
// runs the five-caller sweep.)
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { person, ORG, LOC_A } from '../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({ tag: 'db' })) }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))
vi.mock('@/lib/org-event-fees', () => ({ getOrgEventFees: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { getOrgEventFees } = await import('@/lib/org-event-fees')
const { GET } = await import('./route.js')

const get = () => GET(new Request('http://localhost/api/accounting/event-fees'))

beforeEach(() => {
  vi.clearAllMocks()
  getOrgEventFees.mockResolvedValue({ total_cents: 120 })
})

describe('GET /api/accounting/event-fees', () => {
  it('401 signed out', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await get()).status).toBe(401)
  })

  it('403 for a studio owner without an organisation admin grant', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_A]: { role: 'owner' } }, LOC_A))
    const res = await get()
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ success: false, error: 'Forbidden' })
    expect(getOrgEventFees).not.toHaveBeenCalled()
  })

  it('an organisation admin gets the active organisation fees', async () => {
    getCurrentUser.mockResolvedValue(person({ [LOC_A]: { role: 'staff' } }, LOC_A, { orgAdminOrgIds: [ORG] }))
    const res = await get()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: { total_cents: 120 } })
    expect(getOrgEventFees).toHaveBeenCalledWith({ tag: 'db' }, ORG)
  })
})
