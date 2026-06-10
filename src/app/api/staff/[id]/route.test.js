import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(),
  getUserLocationIds: (u) => (u?.locations || []).map(l => l.id),
}))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({})) }))
vi.mock('@/lib/staff', () => ({ getStaffForUser: vi.fn() }))

import { GET } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { getStaffForUser } from '@/lib/staff'

const req = () => new Request('http://localhost/api/staff/p1')
const props = { params: { id: 'p1' } }

beforeEach(() => vi.clearAllMocks())

describe('GET /api/staff/[id]', () => {
  it('401 when not authenticated', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await GET(req(), props)
    expect(res.status).toBe(401)
    expect(getStaffForUser).not.toHaveBeenCalled()
  })
  it('404 when the service reports cross-tenant / missing', async () => {
    getCurrentUser.mockResolvedValue({ role: 'owner', locations: [{ id: 'loc-1' }] })
    getStaffForUser.mockResolvedValue({ ok: false, status: 404, error: 'Not found' })
    const res = await GET(req(), props)
    expect(res.status).toBe(404)
  })
  it('200 with the profile when the service returns it', async () => {
    getCurrentUser.mockResolvedValue({ role: 'owner', locations: [{ id: 'loc-1' }] })
    getStaffForUser.mockResolvedValue({ ok: true, data: { id: 'p1', full_name: 'Ada' } })
    const res = await GET(req(), props)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.data.full_name).toBe('Ada')
    expect(getStaffForUser).toHaveBeenCalledWith(expect.objectContaining({ id: 'p1' }))
  })
})
