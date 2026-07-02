// Route tests for GET /api/bridge/inbody/backfill-pending (audit W2-H / M1).
//
// The queue must be scoped to the bridge's location (requests carry
// location_id at create) — a bridge for location A must never be handed
// location B's backfill requests (member phone numbers).

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/bridge-auth', () => ({ verifyBridgeToken: vi.fn() }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn() }))

import { GET } from './route.js'
import { createServerClient } from '@/lib/supabase'
import { verifyBridgeToken } from '@/lib/bridge-auth'

const REQUESTS = [
  { id: 'r-A', phone: '0851111111', status: 'pending', location_id: 'loc-A' },
  { id: 'r-B', phone: '0852222222', status: 'pending', location_id: 'loc-B' },
]

function makeDb() {
  return {
    from(table) {
      if (table !== 'inbody_backfill_requests') return {}
      const state = { loc: null }
      const b = {
        select: () => b,
        eq: (col, val) => { if (col === 'location_id') state.loc = val; return b },
        order: () => b,
        limit: () => {
          const rows = REQUESTS.filter(
            (r) => r.status === 'pending' && (!state.loc || r.location_id === state.loc),
          )
          return Promise.resolve({ data: rows, error: null })
        },
      }
      return b
    },
  }
}

function reqWithAuth() { return { headers: { get: () => 'Bearer bbr_x' } } }

beforeEach(() => {
  vi.clearAllMocks()
  createServerClient.mockReturnValue(makeDb())
})

describe('GET /api/bridge/inbody/backfill-pending — location scoping', () => {
  it('a bridge for location A does NOT receive location B requests', async () => {
    verifyBridgeToken.mockResolvedValue({ bridgeId: 'br-A', locationId: 'loc-A' })
    const res = await GET(reqWithAuth())
    const json = await res.json()
    const ids = json.pending.map((p) => p.request_id)
    expect(ids).toContain('r-A')
    expect(ids).not.toContain('r-B')
  })

  it('401s without a valid bridge token', async () => {
    verifyBridgeToken.mockResolvedValue(null)
    const res = await GET(reqWithAuth())
    expect(res.status).toBe(401)
  })
})
