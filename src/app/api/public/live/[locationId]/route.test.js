// Tests for the public live-TV route.
//
// Post audit W2/#11: the cumulative HR aggregate (zones_seconds / effort_points
// / peak_hr_bpm / avg_hr_bpm) is maintained INCREMENTALLY at ingest and read
// straight off the heart_rate_sessions row — the route NO LONGER scans every
// sample every poll. The only per-poll hr_samples read left is the last-30s
// window for the "current BPM" moving average, and that must still page past the
// 1000-row db-max-rows cap (a 33+-strap class breaches it).

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/bridge-samples', () => ({
  isBridgeOnline: () => true,
  latestBridgeSeenMs: () => 0,
  maskStrapLabel: (k) => k,
}))
vi.mock('@/lib/live-class', () => ({ getAvailableStraps: vi.fn(() => Promise.resolve([])) }))
vi.mock('@/lib/class-occurrences', () => ({ resolveCurrentClassForTv: vi.fn(() => Promise.resolve(null)) }))

import { GET } from './route.js'
import { createServerClient } from '@/lib/supabase'

const PAGE = 1000

// Build a mock supabase client whose `hr_samples` select honours `.range(from,to)`
// over a synthetic sample array (the last-30s recent-BPM read), so selectAll's
// paging loop is exercised for real. The session rows carry the running
// aggregate columns the route now renders from.
function makeDb({ samples, sessions }) {
  function hrSamplesQuery() {
    const chain = {
      select: () => chain,
      in: () => chain,
      gte: () => chain,
      order: () => chain,
      range: (from, to) => Promise.resolve({ data: samples.slice(from, to + 1), error: null }),
      then: (resolve) => resolve({ data: samples.slice(0, PAGE), error: null }),
    }
    return chain
  }

  const defaultSession = {
    id: 'sess-1',
    contact_id: 'c-1',
    device_identifier: null,
    started_at: '2026-07-02T09:00:00Z',
    max_hr_used: 190,
    last_sample_at: new Date().toISOString(),
    zones_seconds: { 1: 0, 2: 0, 3: 600, 4: 300, 5: 120 },
    effort_points: 62,
    peak_hr_bpm: 188,
    avg_hr_bpm: 165,
    contacts: { id: 'c-1', name: 'Alice Smith', location_id: 'loc-1', hr_leaderboard_opt_out: false },
  }
  const sessionRows = sessions || [defaultSession]

  return {
    rpc: vi.fn(() => Promise.resolve({ data: 1, error: null })), // rate_limit_hit → count 1
    from: vi.fn((table) => {
      if (table === 'locations') {
        return { select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: { id: 'loc-1', name: 'Stillorgan' }, error: null }) }) }) }
      }
      if (table === 'ble_bridges') {
        return { select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }) }
      }
      if (table === 'heart_rate_sessions') {
        return { select: () => ({ eq: () => ({ is: () => ({ order: () => Promise.resolve({ data: sessionRows, error: null }) }) }) }) }
      }
      if (table === 'class_timer_runs') {
        return { select: () => ({ eq: () => ({ in: () => ({ order: () => ({ limit: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) }) }) }) }
      }
      if (table === 'hr_samples') {
        return hrSamplesQuery()
      }
      throw new Error(`unexpected table: ${table}`)
    }),
  }
}

async function callRoute(db) {
  createServerClient.mockReturnValue(db)
  const request = { headers: { get: () => null } }
  const res = await GET(request, { params: Promise.resolve({ locationId: 'loc-1' }) })
  return res
}

beforeEach(() => { vi.clearAllMocks() })

describe('GET /api/public/live/[locationId]', () => {
  it('renders the cumulative aggregate straight off the session row (no per-poll scan)', async () => {
    const db = makeDb({ samples: [] })
    const res = await callRoute(db)
    const body = await res.json()

    expect(body.ok).toBe(true)
    expect(body.sessions).toHaveLength(1)
    const tile = body.sessions[0]
    // Cumulative fields come from the row's incrementally-maintained columns.
    expect(tile.peakBpm).toBe(188)
    expect(tile.avgBpm).toBe(165)
    expect(tile.effortPoints).toBe(62)
    expect(tile.zonesSeconds).toEqual({ 1: 0, 2: 0, 3: 600, 4: 300, 5: 120 })
    expect(res.headers.get('Cache-Control')).toBe('no-store')
  })

  it('coalesces null aggregate columns on a fresh session to a stable shape', async () => {
    const sessions = [{
      id: 'fresh', contact_id: 'c-2', device_identifier: null,
      started_at: '2026-07-02T09:00:00Z', max_hr_used: 190, last_sample_at: new Date().toISOString(),
      zones_seconds: null, effort_points: null, peak_hr_bpm: null, avg_hr_bpm: null,
      contacts: { id: 'c-2', name: 'New Person', location_id: 'loc-1', hr_leaderboard_opt_out: false },
    }]
    const db = makeDb({ samples: [], sessions })
    const res = await callRoute(db)
    const body = await res.json()
    const tile = body.sessions[0]
    expect(tile.zonesSeconds).toEqual({ 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 })
    expect(tile.effortPoints).toBe(0)
    expect(tile.peakBpm).toBe(null)
    expect(tile.avgBpm).toBe(null)
  })

  it('current BPM comes from the last-30s read, which pages past the 1000-row cap', async () => {
    // 1500 recent samples: first 1000 are 150bpm, then 170bpm from row 1000 on.
    // The current-BPM average must reflect the FULL recent window (paged), not
    // just the first 1000 rows. With paging the mean is pulled above 150.
    const base = Date.parse('2026-07-02T09:00:00Z')
    const samples = []
    for (let i = 0; i < 1500; i++) {
      const bpm = i < 1000 ? 150 : 170
      samples.push({ session_id: 'sess-1', recorded_at: new Date(base + i * 1000).toISOString(), bpm })
    }
    const db = makeDb({ samples })
    const res = await callRoute(db)
    const body = await res.json()
    // mean of 1000×150 + 500×170 = (150000 + 85000)/1500 = 156.67 → 157.
    // An un-paged read (first 1000 only) would give 150 — the regression gate.
    expect(body.sessions[0].currentBpm).toBe(157)
  })

  it('returns 429 when the rate limiter denies the request', async () => {
    const db = makeDb({ samples: [] })
    db.rpc = vi.fn(() => Promise.resolve({ data: 100000, error: null }))
    const res = await callRoute(db)
    expect(res.status).toBe(429)
  })

  // DECISION #1 (mig 348) — opted-out members are dropped from the public tiles;
  // opted-in members and anonymous (null-contact) walk-ins are kept.
  it('excludes opted-out members from the tiles, keeps opted-in + anonymous walk-ins', async () => {
    const sessions = [
      { id: 'shown', contact_id: 'c-shown', device_identifier: null, started_at: '2026-07-02T09:00:00Z', max_hr_used: 190, last_sample_at: new Date().toISOString(), zones_seconds: { 3: 60 }, effort_points: 3, peak_hr_bpm: 150, avg_hr_bpm: 150, contacts: { id: 'c-shown', name: 'Alice Smith', location_id: 'loc-1', hr_leaderboard_opt_out: false } },
      { id: 'hidden', contact_id: 'c-hidden', device_identifier: null, started_at: '2026-07-02T09:01:00Z', max_hr_used: 190, last_sample_at: new Date().toISOString(), zones_seconds: { 3: 60 }, effort_points: 3, peak_hr_bpm: 150, avg_hr_bpm: 150, contacts: { id: 'c-hidden', name: 'Bob Jones', location_id: 'loc-1', hr_leaderboard_opt_out: true } },
      { id: 'anon', contact_id: null, device_identifier: 'ant:45075', started_at: '2026-07-02T09:02:00Z', max_hr_used: 190, last_sample_at: new Date().toISOString(), zones_seconds: { 3: 60 }, effort_points: 3, peak_hr_bpm: 150, avg_hr_bpm: 150, contacts: null },
    ]
    const db = makeDb({ samples: [], sessions })
    const res = await callRoute(db)
    const body = await res.json()
    expect(body.ok).toBe(true)
    const ids = body.sessions.map((s) => s.id)
    expect(ids).toContain('shown')
    expect(ids).toContain('anon')      // anonymous walk-in unaffected
    expect(ids).not.toContain('hidden') // opted-out member dropped
  })
})
