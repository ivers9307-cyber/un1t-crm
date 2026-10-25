// src/app/api/home-queue/count/route.test.js
// WIDGET.1 — GET /api/home-queue/count runs the REAL withAuth gate, so this
// file proves the gate actually fires (session and widget-token paths) on a
// route that has just been made to accept a second credential type.
// Delegates to getHomeQueueCounts (src/lib/home-queue.js); never assembles
// approval items, ticket subjects or conversation rows itself.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/widget-auth', () => ({ getWidgetUser: vi.fn() }))
vi.mock('@/lib/home-queue', () => ({ getHomeQueueCounts: vi.fn() }))

import { GET } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { getWidgetUser } from '@/lib/widget-auth'
import { getHomeQueueCounts } from '@/lib/home-queue'

const req = () => new Request('http://x/api/home-queue/count')
const staff = { id: 'u1', role: 'staff', activeLocation: { id: 'loc1' } }
const widgetUser = {
  id: 'u2', role: 'staff', authSource: 'widget', activeLocation: { id: 'loc1' },
}

beforeEach(() => {
  vi.clearAllMocks()
  createServerClient.mockReturnValue({ marker: 'db' })
})

describe('GET /api/home-queue/count', () => {
  it('401s when unauthenticated (no session, no widget token)', async () => {
    getCurrentUser.mockResolvedValue(null)
    getWidgetUser.mockResolvedValue(null)
    const res = await GET(req())
    expect(res.status).toBe(401)
    expect(getHomeQueueCounts).not.toHaveBeenCalled()
  })

  it('returns count, bySource and degraded for a session, passing db and user through', async () => {
    getCurrentUser.mockResolvedValue(staff)
    getHomeQueueCounts.mockResolvedValue({
      count: 5, bySource: { approvals: 3, mail: 2, inbox: 0 }, degraded: [],
    })
    const res = await GET(req())
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body).toEqual({
      success: true,
      data: { count: 5, bySource: { approvals: 3, mail: 2, inbox: 0 }, degraded: [] },
    })
    expect(getHomeQueueCounts).toHaveBeenCalledWith({ marker: 'db' }, staff)
  })

  // EMAIL-TICKET-CLEANUP.2 — a failed mailbox-visibility lookup must not
  // read as a confident 0. getHomeQueueCounts rejects for exactly this case
  // (src/lib/home-queue.js); the route mirrors /api/email/tickets/count's
  // own 500 posture so a poller keeps its last good number rather than
  // overwriting it with a confidently wrong "nothing to do".
  it('500s (not a confident 0) when getHomeQueueCounts rejects on a tickets visibility failure', async () => {
    getCurrentUser.mockResolvedValue(staff)
    getHomeQueueCounts.mockRejectedValue(new Error('tickets: mailbox visibility lookup failed'))
    const res = await GET(req())
    const body = await res.json()
    expect(res.status).toBe(500)
    expect(body.success).toBe(false)
  })

  it('200s for a valid widget token with no session', async () => {
    getCurrentUser.mockResolvedValue(null)
    getWidgetUser.mockResolvedValue(widgetUser)
    getHomeQueueCounts.mockResolvedValue({
      count: 2, bySource: { approvals: 1, mail: 1, inbox: 0 }, degraded: [],
    })
    const res = await GET(req())
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.data.count).toBe(2)
    expect(getHomeQueueCounts).toHaveBeenCalledWith({ marker: 'db' }, widgetUser)
  })

  it('does not consult a widget token when a session exists', async () => {
    getCurrentUser.mockResolvedValue(staff)
    getHomeQueueCounts.mockResolvedValue({
      count: 0, bySource: { approvals: 0, mail: 0, inbox: 0 }, degraded: [],
    })
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(getWidgetUser).not.toHaveBeenCalled()
  })
})
