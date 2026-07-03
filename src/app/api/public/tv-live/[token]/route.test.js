// Tests for the P0-3 token-gated live board.
//
// The token resolves tv_displays.token → location, then returns the SAME board
// payload as /api/public/live/[locationId]. A good token returns 200 + data; an
// invalid or inactive token returns 404 (never confirm existence).

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
// Stub the board builder — the board internals are covered by the live-route
// test; here we only assert token resolution + status codes.
vi.mock('@/lib/live-board', () => ({
  buildLiveBoardPayload: vi.fn(() => Promise.resolve({
    ok: true, server_time: 'T', location: { id: 'loc-1', name: 'Stillorgan' },
    bridge: { online: true }, sessions: [], available_straps: [], timer: null, current_class: null,
  })),
}))

import { GET } from './route.js'
import { createServerClient } from '@/lib/supabase'

function makeDb({ display, location }) {
  return {
    rpc: vi.fn(() => Promise.resolve({ data: 1, error: null })), // under rate limit
    from: vi.fn((table) => {
      if (table === 'tv_displays') {
        return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: display, error: null }) }) }) }
      }
      if (table === 'locations') {
        return { select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: location, error: null }) }) }) }
      }
      throw new Error(`unexpected table: ${table}`)
    }),
  }
}

async function callRoute(db, token) {
  createServerClient.mockReturnValue(db)
  const request = { headers: { get: () => null } }
  return GET(request, { params: Promise.resolve({ token }) })
}

beforeEach(() => { vi.clearAllMocks() })

describe('GET /api/public/tv-live/[token]', () => {
  it('resolves a good token to its location and returns the board payload', async () => {
    const db = makeDb({ display: { location_id: 'loc-1', active: true }, location: { id: 'loc-1', name: 'Stillorgan' } })
    const res = await callRoute(db, 'good-token')
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.location).toEqual({ id: 'loc-1', name: 'Stillorgan' })
    expect(res.headers.get('Cache-Control')).toBe('no-store')
  })

  it('returns 404 for an unknown token (no row)', async () => {
    const db = makeDb({ display: null, location: null })
    const res = await callRoute(db, 'bad-token')
    expect(res.status).toBe(404)
  })

  it('returns 404 for an inactive display', async () => {
    const db = makeDb({ display: { location_id: 'loc-1', active: false }, location: { id: 'loc-1', name: 'Stillorgan' } })
    const res = await callRoute(db, 'inactive-token')
    expect(res.status).toBe(404)
  })

  it('returns 429 when the rate limiter denies the request', async () => {
    const db = makeDb({ display: { location_id: 'loc-1', active: true }, location: { id: 'loc-1', name: 'Stillorgan' } })
    db.rpc = vi.fn(() => Promise.resolve({ data: 100000, error: null }))
    const res = await callRoute(db, 'good-token')
    expect(res.status).toBe(429)
  })
})
