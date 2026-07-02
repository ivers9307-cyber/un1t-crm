// Tests for the public live-TV route.
//
// The load-bearing assertion here is PAGINATION: the "all samples" read must
// page past the 1000-row db-max-rows cap. Before the selectAll fix this route
// issued a single un-paged `.select().order(recorded_at asc)` that silently
// returned only the EARLIEST 1000 samples — so a long class's peak/avg/points
// froze on the first minute. The pagination test below FAILS against that old
// code (peak would be 150, the head value) and passes once the read pages.

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
// over a synthetic sample array, so selectAll's paging loop is exercised for real.
function makeDb({ samples }) {
  // Terminal chain for hr_samples: .select().in().[gte()].order().range(from,to)
  function hrSamplesQuery() {
    // `.order()` is awaitable and, like a real un-paged select, returns only the
    // first PAGE rows (the db-max-rows cap) — this is what the OLD un-paged code
    // saw. `.range(from,to)` returns the real slice, so selectAll's paging loop
    // reads everything. This makes the pagination test a genuine regression gate:
    // without .range() (old code) peak = 150 (head only); with paging peak = 188.
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

  const sessionRow = {
    id: 'sess-1',
    contact_id: 'c-1',
    device_identifier: null,
    started_at: '2026-07-02T09:00:00Z',
    max_hr_used: 190,
    last_sample_at: new Date().toISOString(),
    contacts: { id: 'c-1', name: 'Alice Smith', location_id: 'loc-1' },
  }

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
        return { select: () => ({ eq: () => ({ is: () => ({ order: () => Promise.resolve({ data: [sessionRow], error: null }) }) }) }) }
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
  it('pages the all-samples read beyond the 1000-row cap (peak reflects a late sample)', async () => {
    // 1500 samples: the first 1000 are 150bpm, then a 188bpm spike at row 1200.
    // An un-paged select (old bug) returns only the first 1000 → peak 150.
    // A paged read sees the spike → peak 188.
    const base = Date.parse('2026-07-02T09:00:00Z')
    const samples = []
    for (let i = 0; i < 1500; i++) {
      const bpm = i === 1200 ? 188 : 150
      samples.push({ session_id: 'sess-1', recorded_at: new Date(base + i * 1000).toISOString(), bpm })
    }
    const db = makeDb({ samples })
    const res = await callRoute(db)
    const body = await res.json()

    expect(body.ok).toBe(true)
    expect(body.sessions).toHaveLength(1)
    // Load-bearing: peak comes from row 1200 → only visible if the read paged.
    expect(body.sessions[0].peakBpm).toBe(188)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
  })

  it('returns 429 when the rate limiter denies the request', async () => {
    const db = makeDb({ samples: [] })
    // Force the limiter over the max.
    db.rpc = vi.fn(() => Promise.resolve({ data: 100000, error: null }))
    const res = await callRoute(db)
    expect(res.status).toBe(429)
  })
})
