// HOME.3 — GET /api/home-queue. Thin route: auth, delegate to
// assembleHomeQueue (src/lib/home-queue.js, unit-tested on its own), wrap
// the result. These tests are about the ROUTE's own job — the auth gate and
// the envelope/status it wraps the assembler's result in — not re-proving
// the assembler's per-source logic.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/home-queue', () => ({ assembleHomeQueue: vi.fn() }))

import { GET } from './route'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { assembleHomeQueue } from '@/lib/home-queue'

const req = () => new Request('http://x/api/home-queue')
const staff = { id: 'u1', role: 'staff', activeLocation: { id: 'loc1' } }

const EMPTY = { rows: [], counts: { approvals: 0, tickets: 0, inbox: 0 }, total: 0 }

beforeEach(() => {
  vi.clearAllMocks()
  createServerClient.mockReturnValue({ marker: 'db' })
})

describe('GET /api/home-queue', () => {
  it('401s when unauthenticated', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await GET(req())
    expect(res.status).toBe(401)
    expect(assembleHomeQueue).not.toHaveBeenCalled()
  })

  it('returns the assembler result wrapped in the standard envelope', async () => {
    getCurrentUser.mockResolvedValue(staff)
    const data = {
      rows: [{ source: 'tickets', sourceLabel: 'Tickets', id: 't1', title: 'X', subtitle: null, occurredAt: '2026-08-10T00:00:00Z', href: '/communications/tickets' }],
      counts: { approvals: 0, tickets: 1, inbox: 0 },
      total: 1,
    }
    assembleHomeQueue.mockResolvedValue(data)
    const res = await GET(req())
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body).toEqual({ success: true, data })
    expect(assembleHomeQueue).toHaveBeenCalledWith({ marker: 'db' }, staff)
  })

  it('answers empty rather than erroring when there is no active location', async () => {
    getCurrentUser.mockResolvedValue({ ...staff, activeLocation: null })
    assembleHomeQueue.mockResolvedValue(EMPTY)
    const res = await GET(req())
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.data).toEqual(EMPTY)
  })

  it('500s only when every source degraded', async () => {
    getCurrentUser.mockResolvedValue(staff)
    assembleHomeQueue.mockResolvedValue({
      rows: [], counts: { approvals: 0, tickets: 0, inbox: 0 }, total: 0,
      degraded: ['approvals', 'tickets', 'inbox'],
    })
    const res = await GET(req())
    expect(res.status).toBe(500)
  })

  it('stays 200 when only some sources degraded', async () => {
    getCurrentUser.mockResolvedValue(staff)
    const data = {
      rows: [], counts: { approvals: 0, tickets: 3, inbox: 0 }, total: 3,
      degraded: ['approvals'],
    }
    assembleHomeQueue.mockResolvedValue(data)
    const res = await GET(req())
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.data.degraded).toEqual(['approvals'])
  })
})
