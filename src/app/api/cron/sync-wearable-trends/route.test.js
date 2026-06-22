import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ---------------------------------------------------------------------------
// Module mocks (hoisted so imports in the route see the mocked versions)
// ---------------------------------------------------------------------------

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/openwearables', () => ({ createOpenWearablesClient: vi.fn() }))
vi.mock('@/lib/cron-heartbeat', () => ({ stampHeartbeat: vi.fn().mockResolvedValue(undefined) }))

import { createServerClient } from '@/lib/supabase'
import { createOpenWearablesClient } from '@/lib/openwearables'
import { GET } from './route.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(authHeader) {
  return { headers: { get: (h) => (h === 'authorization' ? authHeader : null) } }
}

// Builds a minimal supabase mock that handles the exact query chains
// the route issues in happy-path order:
//   1. hr_provider_connections .select.eq.eq.order.range
//   2. contacts .select.eq.maybeSingle
//   3. member_health_metrics .select.eq.order.limit.maybeSingle  (latest row)
//   4. member_health_metrics .upsert
//   5. second hr_provider_connections page (empty → stop)
//
// Mocks are intentionally additive-sequential via mockReturnValueOnce so the
// test controls exactly what each query returns.
function makeDbMock({
  connections = [{ contact_id: 'c1', provider_user_id: 'ow-u1' }],
  contact = { id: 'c1', location_id: 'loc1' },
  latestMetric = null,
  upsertError = null,
} = {}) {
  const upsertMock = vi.fn().mockResolvedValue({ error: upsertError })

  // Builder helper — returns an object whose chainable methods
  // (select, eq, order, range, limit, maybeSingle, upsert) can be
  // stacked in any order and finally resolved.
  function chain(finalValue) {
    const proxy = new Proxy({}, {
      get(_, prop) {
        if (prop === 'then') return undefined  // not a thenable itself
        if (prop === 'maybeSingle') return () => Promise.resolve({ data: finalValue, error: null })
        if (prop === 'upsert') return upsertMock
        // Every other chained call returns the same proxy
        return () => proxy
      }
    })
    // Allow range() on the first chain to return a resolved promise for connections
    return proxy
  }

  // We need .range() to return an actual result for the connections query.
  // Build a more explicit mock for the connections table.
  let connectionsCallCount = 0
  const connectionsChain = {
    select: () => connectionsChain,
    eq: () => connectionsChain,
    order: () => connectionsChain,
    range: () => {
      connectionsCallCount++
      // First call returns rows; second (next page) returns empty to stop paging
      return Promise.resolve({
        data: connectionsCallCount === 1 ? connections : [],
        error: null,
      })
    },
  }

  const db = {
    from: vi.fn((table) => {
      if (table === 'hr_provider_connections') return connectionsChain
      if (table === 'contacts') {
        const c = {
          select: () => c,
          eq: () => c,
          maybeSingle: () => Promise.resolve({ data: contact, error: null }),
        }
        return c
      }
      if (table === 'member_health_metrics') {
        // Could be a select (latest row lookup) or upsert
        const m = {
          select: () => m,
          eq: () => m,
          order: () => m,
          limit: () => m,
          maybeSingle: () => Promise.resolve({ data: latestMetric, error: null }),
          upsert: upsertMock,
        }
        return m
      }
      return chain(null)
    }),
  }
  return { db, upsertMock }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/cron/sync-wearable-trends', () => {
  beforeEach(() => {
    process.env.CRON_SECRET = 'test-secret'
  })

  afterEach(() => {
    delete process.env.CRON_SECRET
    vi.clearAllMocks()
  })

  it('returns 401 without the correct secret', async () => {
    const res = await GET(makeRequest('Bearer wrong-secret'))
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.success).toBe(false)
  })

  it('returns 401 with no auth header', async () => {
    const res = await GET(makeRequest(null))
    expect(res.status).toBe(401)
  })

  it('happy path: upserts mapped rows and returns success=true', async () => {
    const { db, upsertMock } = makeDbMock({
      connections: [{ contact_id: 'c1', provider_user_id: 'ow-u1' }],
      contact: { id: 'c1', location_id: 'loc1' },
      latestMetric: null,
    })
    createServerClient.mockReturnValue(db)

    const owClient = {
      getTimeseries: vi.fn().mockResolvedValue([
        { type: 'resting_heart_rate', timestamp: '2026-06-20T00:00:00Z', value: 55, unit: 'count/min' },
      ]),
    }
    createOpenWearablesClient.mockReturnValue(owClient)

    const res = await GET(makeRequest('Bearer test-secret'))
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body.success).toBe(true)
    expect(body.connections).toBe(1)
    expect(body.inserted).toBe(1)

    // upsert was called with the mapped rows
    expect(upsertMock).toHaveBeenCalledTimes(1)
    const [rows, opts] = upsertMock.mock.calls[0]
    expect(Array.isArray(rows)).toBe(true)
    expect(rows).toHaveLength(1)
    expect(rows[0].metric).toBe('resting_heart_rate')
    expect(rows[0].contact_id).toBe('c1')
    expect(rows[0].location_id).toBe('loc1')
    expect(rows[0].source).toBe('apple_health')
    expect(opts).toEqual({ onConflict: 'contact_id,metric,recorded_at' })
  })

  it('skips connection when contact not found', async () => {
    const { db, upsertMock } = makeDbMock({
      connections: [{ contact_id: 'missing', provider_user_id: 'ow-u1' }],
      contact: null,
    })
    createServerClient.mockReturnValue(db)
    createOpenWearablesClient.mockReturnValue({ getTimeseries: vi.fn() })

    const res = await GET(makeRequest('Bearer test-secret'))
    const body = await res.json()

    expect(body.success).toBe(true)
    expect(body.connections).toBe(1)
    expect(body.inserted).toBe(0)
    expect(upsertMock).not.toHaveBeenCalled()
  })

  it('does not upsert when getTimeseries returns no valid samples', async () => {
    const { db, upsertMock } = makeDbMock()
    createServerClient.mockReturnValue(db)
    createOpenWearablesClient.mockReturnValue({
      getTimeseries: vi.fn().mockResolvedValue([
        { type: 'steps', timestamp: '2026-06-20T00:00:00Z', value: 9000 }, // filtered by samplesToMetricRows
      ]),
    })

    const res = await GET(makeRequest('Bearer test-secret'))
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.inserted).toBe(0)
    expect(upsertMock).not.toHaveBeenCalled()
  })

  it('continues batch when one connection throws', async () => {
    const { db, upsertMock } = makeDbMock({
      connections: [
        { contact_id: 'c1', provider_user_id: 'ow-u1' },
        { contact_id: 'c2', provider_user_id: 'ow-u2' },
      ],
    })
    createServerClient.mockReturnValue(db)

    let call = 0
    createOpenWearablesClient.mockReturnValue({
      getTimeseries: vi.fn().mockImplementation(() => {
        call++
        if (call === 1) throw new Error('OW down')
        return Promise.resolve([
          { type: 'vo2_max', timestamp: '2026-06-20T00:00:00Z', value: 48, unit: 'mL/min·kg' },
        ])
      }),
    })

    const res = await GET(makeRequest('Bearer test-secret'))
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.connections).toBe(2)
    expect(body.inserted).toBe(1) // second connection succeeded
    expect(upsertMock).toHaveBeenCalledTimes(1) // only the surviving connection upserts
  })
})
