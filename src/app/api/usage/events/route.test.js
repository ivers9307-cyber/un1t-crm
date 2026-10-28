import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({})) }))
vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn() }))
vi.mock('@/lib/log', () => ({ logError: vi.fn() }))
vi.mock('@/lib/app-usage/ingest', async (orig) => ({
  ...(await orig()),
  recordUsageBatch: vi.fn(),
}))

const { getCurrentUser } = await import('@/lib/auth')
const { logError } = await import('@/lib/log')
const { recordUsageBatch } = await import('@/lib/app-usage/ingest')
const { POST } = await import('./route.js')

const S = '11111111-1111-4111-8111-111111111111'
const V = '22222222-2222-4222-8222-222222222222'
const now = new Date().toISOString()
const body = {
  session: { id: S, platform: 'phone', app_version: '2.3.4', started_at: now, ended_at: now },
  visits: [{ id: V, feature: 'contacts', started_at: now, ended_at: now }],
}
const req = (b) => new Request('http://x/api/usage/events', { method: 'POST', body: JSON.stringify(b) })
const staff = { id: 'p1', profileRole: 'staff', isMaster: false, activeLocation: { id: 'loc1' } }

beforeEach(() => {
  vi.clearAllMocks()
  recordUsageBatch.mockResolvedValue({ recorded: true, visits: 1 })
})

describe('POST /api/usage/events', () => {
  it('401s without a user', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await POST(req(body))).status).toBe(401)
    expect(recordUsageBatch).not.toHaveBeenCalled()
  })

  it('answers recorded:false for a master and writes nothing', async () => {
    getCurrentUser.mockResolvedValue({ ...staff, profileRole: 'master', isMaster: true })
    const res = await POST(req(body))
    expect(res.status).toBe(200)
    expect((await res.json()).data.recorded).toBe(false)
    expect(recordUsageBatch).not.toHaveBeenCalled()
  })

  it('answers recorded:false while viewing as someone', async () => {
    getCurrentUser.mockResolvedValue({ ...staff, impersonatingFrom: { id: 'm1' } })
    expect((await (await POST(req(body))).json()).data.recorded).toBe(false)
    expect(recordUsageBatch).not.toHaveBeenCalled()
  })

  it('400s an unknown feature (a path never reaches the table)', async () => {
    getCurrentUser.mockResolvedValue(staff)
    const bad = { ...body, visits: [{ ...body.visits[0], feature: '/contacts/123' }] }
    expect((await POST(req(bad))).status).toBe(400)
    expect(recordUsageBatch).not.toHaveBeenCalled()
  })

  it('400s more than 200 visits', async () => {
    getCurrentUser.mockResolvedValue(staff)
    const many = { ...body, visits: Array.from({ length: 201 }, () => body.visits[0]) }
    expect((await POST(req(many))).status).toBe(400)
  })

  it('records a staff batch as the signed-in person at their active studio', async () => {
    getCurrentUser.mockResolvedValue(staff)
    const res = await POST(req(body))
    expect(res.status).toBe(200)
    expect(recordUsageBatch).toHaveBeenCalledWith(expect.objectContaining({
      profileId: 'p1', locationId: 'loc1', batch: expect.objectContaining({ session: expect.objectContaining({ id: S }) }),
    }))
  })

  it('503s and logs when the write fails', async () => {
    getCurrentUser.mockResolvedValue(staff)
    recordUsageBatch.mockRejectedValue(new Error('usage session write failed: X'))
    const res = await POST(req(body))
    expect(res.status).toBe(503)
    expect(logError).toHaveBeenCalledWith('app-usage', expect.any(String), expect.any(Object))
  })
})
