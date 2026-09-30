// PAGEGATES.1 — /orders/[id] decides at the ORDER's location.
//
// GET /api/orders/[id] and …/cancel judge MANAGER_ROLES and `orders` at the
// order's location (404 for a non-member). The page judged both at the ACTIVE
// studio and never looked at the order: a manager at the order's studio who is
// staff at the active one was redirected, and a stranger's id opened a shell.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { person, MASTER, OUTSIDER, LOC_A, LOC_B } from '../../../../../tests/helpers/role-sweep-callers.js'
import { pageDb, navigationMock } from '../../../../../tests/helpers/page-db-mock.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('next/navigation', () => navigationMock())
vi.mock('@/components/OrderDetail', () => ({ default: () => null }))

import OrderDetailPage from './page.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

const ORDER_ID = 'o0000000-0000-4000-8000-000000000001'
const props = () => ({ params: Promise.resolve({ id: ORDER_ID }) })
const at = (loc) => createServerClient.mockReturnValue(pageDb({ orders: { id: ORDER_ID, location_id: loc } }))
const two = (a, b, perms = {}) => person({ [LOC_A]: { role: a, permissions: perms.a || {} }, [LOC_B]: { role: b, permissions: perms.b || {} } }, LOC_A)

beforeEach(() => vi.clearAllMocks())

describe('/orders/[id]', () => {
  it('opens for a manager at the order\'s studio who is staff at the active one (main: redirected)', async () => {
    getCurrentUser.mockResolvedValue(two('staff', 'manager')); at(LOC_B)
    await expect(OrderDetailPage(props())).resolves.toBeTruthy()
  })
  it('refuses a manager at the active studio who is staff at the order\'s (main: opened; every call 403s)', async () => {
    getCurrentUser.mockResolvedValue(two('manager', 'staff')); at(LOC_B)
    await expect(OrderDetailPage(props())).rejects.toThrow(/^NEXT_REDIRECT:\/$/)
  })
  it('refuses `orders` switched off at the order\'s studio (main: opened)', async () => {
    getCurrentUser.mockResolvedValue(two('owner', 'owner', { a: { orders: true }, b: { orders: false } })); at(LOC_B)
    await expect(OrderDetailPage(props())).rejects.toThrow(/^NEXT_REDIRECT:\/$/)
  })
  it('404s an outsider (main: opened a shell)', async () => {
    getCurrentUser.mockResolvedValue(OUTSIDER); at(LOC_B)
    await expect(OrderDetailPage(props())).rejects.toThrow(/^NEXT_NOT_FOUND$/)
  })
  it('404s a missing order', async () => {
    getCurrentUser.mockResolvedValue(MASTER); createServerClient.mockReturnValue(pageDb({}))
    await expect(OrderDetailPage(props())).rejects.toThrow(/^NEXT_NOT_FOUND$/)
  })
  it('opens for a master', async () => {
    getCurrentUser.mockResolvedValue(MASTER); at(LOC_B)
    await expect(OrderDetailPage(props())).resolves.toBeTruthy()
  })
  it('a failed read is a 500, not a 404 (a DB blip must not look like a missing row)', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    const failing = { select() { return this }, eq() { return this }, maybeSingle: async () => ({ data: null, error: { message: 'boom' } }) }
    createServerClient.mockReturnValue({ from: () => failing })
    await expect(OrderDetailPage(props())).rejects.not.toThrow(/NEXT_NOT_FOUND/)
    await expect(OrderDetailPage(props())).rejects.toBeTruthy()
  })
})
