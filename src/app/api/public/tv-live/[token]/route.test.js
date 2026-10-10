// Tests for the P0-3 token-gated live board.
//
// The token resolves tv_displays.token → location, then returns the board
// payload (buildLiveBoardPayload; its contents are covered by route.board.test.js).
// A good token returns 200 + data; an invalid or inactive token returns 404
// (never confirm existence).

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
// W0.9a — the kiosk render heartbeat (FLEET-CMD.2). Mocked so the tests assert
// the CALL, not the fleet_devices write; deviceFromRequest is the real parser
// so `?device=` is exercised end to end from the request url.
vi.mock('@/lib/fleet-render', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, stampRender: vi.fn(() => Promise.resolve()) }
})
// Stub the board builder — the board internals are covered by
// route.board.test.js; here we only assert token resolution + status codes.
vi.mock('@/lib/live-board', () => ({
  buildLiveBoardPayload: vi.fn(() => Promise.resolve({
    ok: true, server_time: 'T', location: { id: 'loc-1', name: 'Stillorgan' },
    bridge: { online: true }, sessions: [], available_straps: [], timer: null, current_class: null,
  })),
}))

import { GET } from './route.js'
import { createServerClient } from '@/lib/supabase'
import { stampRender } from '@/lib/fleet-render'

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

async function callRoute(db, token, { url } = {}) {
  createServerClient.mockReturnValue(db)
  const request = { headers: { get: () => null }, url: url ?? `https://crm.test/api/public/tv-live/${token}` }
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

  // W0.9a — kiosks poll the token URL with ?device= (W0.9b), so the token
  // route must stamp the FLEET-CMD.2 render heartbeat: with the device name
  // from ?device= and the location the TOKEN resolved to (never a
  // caller-supplied id).
  it('stamps the render heartbeat for ?device= against the token-resolved location', async () => {
    const db = makeDb({ display: { location_id: 'loc-1', active: true }, location: { id: 'loc-1', name: 'Stillorgan' } })
    const res = await callRoute(db, 'good-token', { url: 'https://crm.test/api/public/tv-live/good-token?device=kiosk-1' })
    expect(res.status).toBe(200)
    expect(stampRender).toHaveBeenCalledTimes(1)
    expect(stampRender).toHaveBeenCalledWith(db, 'kiosk-1', 'loc-1')
  })

  it('does not stamp when there is no device param', async () => {
    const db = makeDb({ display: { location_id: 'loc-1', active: true }, location: { id: 'loc-1', name: 'Stillorgan' } })
    const res = await callRoute(db, 'good-token')
    expect(res.status).toBe(200)
    expect(stampRender).not.toHaveBeenCalled()
  })

  it('does not stamp for an unknown token (device names cannot be probed)', async () => {
    const db = makeDb({ display: null, location: null })
    const res = await callRoute(db, 'bad-token', { url: 'https://crm.test/api/public/tv-live/bad-token?device=kiosk-1' })
    expect(res.status).toBe(404)
    expect(stampRender).not.toHaveBeenCalled()
  })
})
