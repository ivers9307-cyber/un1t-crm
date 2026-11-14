// APPROVALS.1 / APPROVALSQ.6 — GET /api/approvals/pending.
// Default: the active studio's list, unchanged, plus the eligible `studios`.
// ?scope=all: the union of the per-studio lists (src/lib/approvals/all-studios.js).

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/approvals/registry', () => ({ getPendingApprovals: vi.fn() }))
vi.mock('@/lib/approvals/all-studios', () => ({
  getPendingApprovalsAllStudios: vi.fn(),
  listEligibleStudios: vi.fn(),
}))

import { GET } from './route'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { getPendingApprovals } from '@/lib/approvals/registry'
import { getPendingApprovalsAllStudios, listEligibleStudios } from '@/lib/approvals/all-studios'

const req = (qs = '') => new Request(`http://x/api/approvals/pending${qs}`)
const user = { id: 'u1', role: 'owner', activeLocation: { id: 'loc1' } }
const active = { providers: [{ key: 'time_off', count: 1, items: [{ id: 'a' }], failedItems: [] }], total: 1 }
const STUDIOS = [{ id: 'loc1', name: 'One' }, { id: 'loc2', name: 'Two' }]

beforeEach(() => {
  vi.clearAllMocks()
  createServerClient.mockReturnValue({ marker: 'db' })
  getPendingApprovals.mockResolvedValue(active)
  listEligibleStudios.mockReturnValue({ studios: STUDIOS, truncated: false })
  getPendingApprovalsAllStudios.mockResolvedValue({
    providers: [], total: 0, scope: 'all', studios: STUDIOS, failedStudios: [], truncated: false,
  })
})

describe('GET /api/approvals/pending', () => {
  it('401s when unauthenticated, without touching either list', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await GET(req())
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
    expect(getPendingApprovals).not.toHaveBeenCalled()
    expect(getPendingApprovalsAllStudios).not.toHaveBeenCalled()
  })

  it('401s on scope=all too', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await GET(req('?scope=all'))
    expect(res.status).toBe(401)
    expect(getPendingApprovalsAllStudios).not.toHaveBeenCalled()
  })

  it('default: the registry result unchanged, plus studios, and no all-studios work', async () => {
    getCurrentUser.mockResolvedValue(user)
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: { ...active, studios: STUDIOS } })
    expect(getPendingApprovals).toHaveBeenCalledWith({ marker: 'db' }, user)
    expect(getPendingApprovalsAllStudios).not.toHaveBeenCalled()
  })

  it.each(['?scope=this', '?scope=', '?scope=ALL', '?scope=all%20', '?other=all'])('any scope other than "all" (%s) is the default', async (qs) => {
    getCurrentUser.mockResolvedValue(user)
    const res = await GET(req(qs))
    expect((await res.json()).data).toEqual({ ...active, studios: STUDIOS })
    expect(getPendingApprovalsAllStudios).not.toHaveBeenCalled()
  })

  it('default still answers when the studio list cannot be built (studios: [])', async () => {
    getCurrentUser.mockResolvedValue(user)
    listEligibleStudios.mockImplementation(() => { throw new Error('x') })
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({ ...active, studios: [] })
  })

  it('scope=all returns the merged all-studios result and does not run the single-studio registry', async () => {
    getCurrentUser.mockResolvedValue(user)
    const res = await GET(req('?scope=all'))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.data).toMatchObject({ scope: 'all', studios: STUDIOS, failedStudios: [], truncated: false })
    expect(getPendingApprovalsAllStudios).toHaveBeenCalledWith({ marker: 'db' }, user)
    expect(getPendingApprovals).not.toHaveBeenCalled()
  })

  it('a thrown error is a 500 with the message, as before', async () => {
    getCurrentUser.mockResolvedValue(user)
    getPendingApprovals.mockRejectedValue(new Error('db down'))
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ success: false, error: 'db down' })
  })
})
