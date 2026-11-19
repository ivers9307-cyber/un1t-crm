// ORDERSVIEW.1 — GET /api/orders/summary: the same gate as the Orders list,
// scoped to the active studio, through the real withAuth wrapper.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({ tag: 'db' })) }))
const loadOrdersSummary = vi.fn()
vi.mock('@/lib/orders-summary', () => ({ loadOrdersSummary: (...a) => loadOrdersSummary(...a) }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { GET } = await import('./route.js')

const L1 = 'a0000000-0000-0000-0000-000000000001'
const userAs = (role, { orders = true, active = true } = {}) => ({
  id: 'u1', role, profileRole: role,
  activeLocation: active ? { id: L1, features: { orders: true } } : null,
  activeAssignment: { role, permissions: { orders } },
  rolesByLocation: { [L1]: role },
  assignmentsByLocation: { [L1]: { role, permissions: { orders } } },
  locations: [{ id: L1, role, features: { orders: true } }],
})
const get = (qs = '') => GET(new Request(`http://localhost/api/orders/summary${qs}`), { params: Promise.resolve({}) })

beforeEach(() => {
  vi.clearAllMocks()
  loadOrdersSummary.mockResolvedValue({ totals: [], studios: [], refunds: [], truncated: false })
})

describe('GET /api/orders/summary', () => {
  it('a manager gets the active studio, with the period passed through', async () => {
    getCurrentUser.mockResolvedValue(userAs('manager'))
    const res = await get('?from=2026-11-01T00:00:00Z&to=bad')
    expect(res.status).toBe(200)
    expect(loadOrdersSummary).toHaveBeenCalledWith({ tag: 'db' }, { locationId: L1, from: '2026-11-01T00:00:00Z', to: null })
  })

  it('staff are refused', async () => {
    getCurrentUser.mockResolvedValue(userAs('staff'))
    expect((await get()).status).toBe(403)
    expect(loadOrdersSummary).not.toHaveBeenCalled()
  })

  it('without the orders permission, refused', async () => {
    getCurrentUser.mockResolvedValue(userAs('manager', { orders: false }))
    expect((await get()).status).toBe(403)
  })

  it('a non-master with no active studio sees nothing, and nothing is read', async () => {
    getCurrentUser.mockResolvedValue(userAs('owner', { active: false }))
    const body = await (await get()).json()
    expect(body.data.totals).toEqual([])
    expect(loadOrdersSummary).not.toHaveBeenCalled()
  })

  it('a failed read is a 503, never zero totals', async () => {
    getCurrentUser.mockResolvedValue(userAs('owner'))
    loadOrdersSummary.mockRejectedValue(new Error('down'))
    const res = await get()
    expect(res.status).toBe(503)
  })
})
