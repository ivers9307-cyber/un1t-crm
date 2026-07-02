// Route tests for POST /api/bridge/inbody/backfill-ingest (audit W2-H / M1).
//
// inbody_backfill_requests.location_id IS set at create, so the guard is a
// direct location_id equality check: a bridge for location A must not close /
// ingest location B's backfill request (which carries a member phone).

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/bridge-auth', () => ({ verifyBridgeToken: vi.fn() }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn() }))
vi.mock('@/lib/inbody-ingest', () => ({ ingestScan: vi.fn() }))

import { POST } from './route.js'
import { createServerClient } from '@/lib/supabase'
import { verifyBridgeToken } from '@/lib/bridge-auth'
import { ingestScan } from '@/lib/inbody-ingest'

const REQUESTS = {
  'r-A': { id: 'r-A', phone: '0851111111', status: 'pending', location_id: 'loc-A' },
  'r-B': { id: 'r-B', phone: '0852222222', status: 'pending', location_id: 'loc-B' },
}

function makeDb() {
  const updates = []
  return {
    _updates: updates,
    from(table) {
      if (table === 'inbody_backfill_requests') {
        const b = {}
        b._id = null
        b.select = () => b
        b.eq = (_c, id) => { b._id = id; return b }
        b.maybeSingle = () => Promise.resolve({ data: REQUESTS[b._id] || null, error: null })
        b.update = (payload) => { b._update = payload; return b }
        b.then = (resolve) => {
          if (b._update !== undefined) updates.push({ id: b._id, payload: b._update })
          return Promise.resolve({ error: null }).then(resolve)
        }
        return b
      }
      return {}
    },
  }
}

function reqWith(body) { return { headers: { get: () => 'Bearer bbr_x' }, json: async () => body } }

let db
beforeEach(() => {
  vi.clearAllMocks()
  db = makeDb()
  createServerClient.mockReturnValue(db)
  verifyBridgeToken.mockResolvedValue({ bridgeId: 'br-A', locationId: 'loc-A' })
  ingestScan.mockResolvedValue({ ok: true })
})

describe('POST /api/bridge/inbody/backfill-ingest — cross-location guard', () => {
  it('closes an in-location request', async () => {
    const res = await POST(reqWith({ request_id: 'r-A', scans: [{ datetimes: '20260101100000', raw: {} }] }))
    const json = await res.json()
    expect(json.ok).toBe(true)
    expect(json.ingested).toBe(1)
    expect(db._updates.some((u) => u.payload.status === 'done')).toBe(true)
  })

  it('REJECTS a cross-location request as 404 and does not touch it', async () => {
    const res = await POST(reqWith({ request_id: 'r-B', scans: [{ datetimes: '20260101100000', raw: {} }] }))
    expect(res.status).toBe(404)
    expect(ingestScan).not.toHaveBeenCalled()
    expect(db._updates).toHaveLength(0)
  })

  it('REJECTS a non-phone usertoken (400) before ingesting', async () => {
    const res = await POST(reqWith({ request_id: 'r-A', usertoken: 'attacker@x.com', scans: [{ datetimes: '20260101100000', raw: {} }] }))
    expect(res.status).toBe(400)
    expect(ingestScan).not.toHaveBeenCalled()
  })

  it('401s without a valid bridge token', async () => {
    verifyBridgeToken.mockResolvedValue(null)
    const res = await POST(reqWith({ request_id: 'r-A' }))
    expect(res.status).toBe(401)
  })
})
