// HOME.3 — GET /api/home-queue/count. Cheap sidebar/nav badge: delegates to
// getHomeQueueCount (src/lib/home-queue.js), never assembles rows.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/home-queue', () => ({ getHomeQueueCount: vi.fn() }))

import { GET } from './route'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { getHomeQueueCount } from '@/lib/home-queue'

const req = () => new Request('http://x/api/home-queue/count')
const staff = { id: 'u1', role: 'staff', activeLocation: { id: 'loc1' } }

beforeEach(() => {
  vi.clearAllMocks()
  createServerClient.mockReturnValue({ marker: 'db' })
})

describe('GET /api/home-queue/count', () => {
  it('401s when unauthenticated', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await GET(req())
    expect(res.status).toBe(401)
    expect(getHomeQueueCount).not.toHaveBeenCalled()
  })

  it('returns { success, data: { count } } from getHomeQueueCount', async () => {
    getCurrentUser.mockResolvedValue(staff)
    getHomeQueueCount.mockResolvedValue(7)
    const res = await GET(req())
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body).toEqual({ success: true, data: { count: 7 } })
    expect(getHomeQueueCount).toHaveBeenCalledWith({ marker: 'db' }, staff)
  })

  it('answers 0 rather than erroring for a session with no active location', async () => {
    getCurrentUser.mockResolvedValue({ ...staff, activeLocation: null })
    getHomeQueueCount.mockResolvedValue(0)
    const res = await GET(req())
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.data.count).toBe(0)
  })
})
