// Tests for the W0.9a token-gated challenge board.
//
// The token resolves tv_displays.token → location, then returns the SAME
// challenge payload for the resolved location. A good token returns 200 +
// data scoped to THAT location; an invalid or inactive token returns 404
// (never confirm existence); the limiter is keyed per token + IP.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
// Stub the standings computation — it is covered by the challenges-io tests;
// here we only assert token resolution, scoping and status codes.
vi.mock('@/lib/challenges-io', () => ({
  computeStandings: vi.fn(() => Promise.resolve([
    { contact_id: 'c-1', name: 'Alice S.', value: 120, rank: 1 },
    { contact_id: 'c-2', name: 'Bob T.', value: 80, rank: 2 },
  ])),
  computeCollective: vi.fn(() => Promise.resolve({ total: 500, target: 1000, pct: 50 })),
}))

import { GET } from './route.js'
import { createServerClient } from '@/lib/supabase'
import { computeStandings } from '@/lib/challenges-io'

const today = new Date()
const iso = (d) => d.toISOString().slice(0, 10)
const ACTIVE_CHALLENGE = {
  id: 'ch-1', name: 'October Points', mode: 'individual', metric: 'points',
  starts_on: iso(new Date(today.getTime() - 3 * 86_400_000)),
  ends_on: iso(new Date(today.getTime() + 3 * 86_400_000)),
  target: null,
}

function makeDb({ display, location, challenges = [] }) {
  const challengesEq = vi.fn(() => ({ order: () => Promise.resolve({ data: challenges, error: null }) }))
  return {
    rpc: vi.fn(() => Promise.resolve({ data: 1, error: null })), // under rate limit
    _challengesEq: challengesEq,
    from: vi.fn((table) => {
      if (table === 'tv_displays') {
        return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: display, error: null }) }) }) }
      }
      if (table === 'locations') {
        return { select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: location, error: null }) }) }) }
      }
      if (table === 'challenges') {
        return { select: () => ({ eq: challengesEq }) }
      }
      throw new Error(`unexpected table: ${table}`)
    }),
  }
}

async function callRoute(db, token) {
  createServerClient.mockReturnValue(db)
  const request = { headers: { get: () => null }, url: `https://crm.test/api/public/tv-challenges/${token}` }
  return GET(request, { params: Promise.resolve({ token }) })
}

beforeEach(() => { vi.clearAllMocks() })

describe('GET /api/public/tv-challenges/[token]', () => {
  it('resolves a good token to its location and returns the challenge payload scoped to it', async () => {
    const db = makeDb({
      display: { location_id: 'loc-1', active: true },
      location: { id: 'loc-1', name: 'Stillorgan' },
      challenges: [ACTIVE_CHALLENGE],
    })
    const res = await callRoute(db, 'good-token')
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.location).toEqual({ id: 'loc-1', name: 'Stillorgan' })
    expect(res.headers.get('Cache-Control')).toBe('no-store')

    // Scoped to the TOKEN's location, never a caller-supplied id.
    expect(db._challengesEq).toHaveBeenCalledWith('location_id', 'loc-1')
    for (const call of computeStandings.mock.calls) expect(call[1].locationId).toBe('loc-1')

    // Same shape as the location-keyed twin: projected standings (no contact ids).
    expect(body.challenges).toHaveLength(1)
    expect(body.challenges[0]).toMatchObject({ id: 'ch-1', name: 'October Points', mode: 'individual', metric: 'points' })
    expect(body.challenges[0].standings).toEqual([
      { name: 'Alice S.', value: 120, rank: 1 },
      { name: 'Bob T.', value: 80, rank: 2 },
    ])
    expect(body.gymBoard).toEqual([
      { name: 'Alice S.', value: 120, rank: 1 },
      { name: 'Bob T.', value: 80, rank: 2 },
    ])
    expect(JSON.stringify(body)).not.toContain('contact_id')
  })

  it('returns 404 for an unknown token (no row) without touching challenges', async () => {
    const db = makeDb({ display: null, location: null })
    const res = await callRoute(db, 'bad-token')
    expect(res.status).toBe(404)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(db._challengesEq).not.toHaveBeenCalled()
    expect(computeStandings).not.toHaveBeenCalled()
  })

  it('returns 404 for an inactive display', async () => {
    const db = makeDb({ display: { location_id: 'loc-1', active: false }, location: { id: 'loc-1', name: 'Stillorgan' } })
    const res = await callRoute(db, 'inactive-token')
    expect(res.status).toBe(404)
    expect(computeStandings).not.toHaveBeenCalled()
  })

  it('returns 404 when the token has no token at all', async () => {
    const db = makeDb({ display: null, location: null })
    const res = await callRoute(db, '')
    expect(res.status).toBe(404)
  })

  it('rate-limits per token + IP and returns 429 when the limiter denies', async () => {
    const db = makeDb({ display: { location_id: 'loc-1', active: true }, location: { id: 'loc-1', name: 'Stillorgan' } })
    db.rpc = vi.fn(() => Promise.resolve({ data: 100000, error: null }))
    const res = await callRoute(db, 'good-token')
    expect(res.status).toBe(429)
    const key = db.rpc.mock.calls[0][1]?.p_key ?? JSON.stringify(db.rpc.mock.calls[0])
    expect(String(key)).toContain('good-token')
  })
})
