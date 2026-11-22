// Route tests for POST /api/bridge/inbody/ingest (security audit W2-H / M1).
//
// THE LEAK guarded here: before the fix, ingest looked up the event by id and
// stamped it with the CALLING bridge's location — so a bridge for location A
// could claim + ingest location B's scan. The fix rejects any event whose
// `account` doesn't map to the bridge's location, and any non-phone tel_hp.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/bridge-auth', () => ({ verifyBridgeToken: vi.fn() }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn() }))
vi.mock('@/lib/inbody-ingest', () => ({ ingestScan: vi.fn() }))

import { POST } from './route.js'
import { createServerClient } from '@/lib/supabase'
import { verifyBridgeToken } from '@/lib/bridge-auth'
import { ingestScan } from '@/lib/inbody-ingest'

const LOCATIONS = {
  'loc-A': { settings: { inbody: { accounts: ['accta'] } } },
}

// e-B1 belongs to location B (account acctb); loc-A's bridge must NOT ingest it.
const EVENTS = {
  'e-A1': { id: 'e-A1', account: 'accta', tel_hp: '0851111111', test_datetime: '20260101100000', processed: false },
  'e-B1': { id: 'e-B1', account: 'acctb', tel_hp: '0852222222', test_datetime: '20260101110000', processed: false },
  'e-junk': { id: 'e-junk', account: 'accta', tel_hp: 'attacker@x.com', test_datetime: '20260101120000', processed: false },
}

function makeDb() {
  const updates = []
  return {
    _updates: updates,
    from(table) {
      if (table === 'locations') {
        return {
          select: () => ({
            eq: (_c, id) => ({ maybeSingle: () => Promise.resolve({ data: LOCATIONS[id] || null, error: null }) }),
          }),
        }
      }
      if (table === 'inbody_webhook_events') {
        const b = {}
        b._id = null
        b.select = () => b
        b.eq = (_c, id) => { b._id = id; return b }
        b.maybeSingle = () => Promise.resolve({ data: EVENTS[b._id] || null, error: null })
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
  ingestScan.mockResolvedValue({ ok: true, linked: true, contactId: 'c-1' })
})

describe('POST /api/bridge/inbody/ingest — cross-location guard', () => {
  it('ingests an in-location event', async () => {
    const res = await POST(reqWith({ results: [{ event_id: 'e-A1', raw: {} }] }))
    const json = await res.json()
    expect(json.processed).toBe(1)
    expect(json.rejected).toBe(0)
    expect(ingestScan).toHaveBeenCalledOnce()
    expect(db._updates).toHaveLength(1)
  })

  it('REJECTS a cross-location event and does not ingest or stamp it', async () => {
    const res = await POST(reqWith({ results: [{ event_id: 'e-B1', raw: {} }] }))
    const json = await res.json()
    expect(json.processed).toBe(0)
    expect(json.rejected).toBe(1)
    expect(ingestScan).not.toHaveBeenCalled()
    expect(db._updates).toHaveLength(0) // never marked processed / stamped with loc-A
  })

  it('REJECTS an event with a non-phone tel_hp', async () => {
    const res = await POST(reqWith({ results: [{ event_id: 'e-junk', raw: {} }] }))
    const json = await res.json()
    expect(json.processed).toBe(0)
    expect(json.rejected).toBe(1)
    expect(ingestScan).not.toHaveBeenCalled()
  })

  it('401s without a valid bridge token', async () => {
    verifyBridgeToken.mockResolvedValue(null)
    const res = await POST(reqWith({ results: [] }))
    expect(res.status).toBe(401)
  })
})

// INBODYDEDUPE.1 — an event whose scan was already on record recorded nothing
// new, but it is HANDLED: marked processed and counted as a duplicate, never
// left pending for the Pi to fetch again.
describe('POST /api/bridge/inbody/ingest — duplicate scans', () => {
  it('marks a duplicate event processed and counts it', async () => {
    ingestScan.mockResolvedValue({ ok: true, linked: true, contactId: 'c-1', duplicate: true })
    const json = await (await POST(reqWith({ results: [{ event_id: 'e-A1', raw: {} }] }))).json()
    expect(json).toMatchObject({ processed: 1, duplicates: 1, rejected: 0 })
    expect(db._updates).toHaveLength(1)
    expect(db._updates[0]).toMatchObject({ id: 'e-A1', payload: { processed: true, matched_contact_id: 'c-1', location_id: 'loc-A' } })
  })

  it('a new scan is not counted as a duplicate', async () => {
    ingestScan.mockResolvedValue({ ok: true, linked: false, contactId: null, duplicate: false })
    const json = await (await POST(reqWith({ results: [{ event_id: 'e-A1', raw: {} }] }))).json()
    expect(json).toMatchObject({ processed: 1, duplicates: 0 })
  })

  it('a failed scan write leaves the event unprocessed', async () => {
    ingestScan.mockResolvedValue({ ok: false, reason: 'upsert_failed', error: 'boom' })
    const json = await (await POST(reqWith({ results: [{ event_id: 'e-A1', raw: {} }] }))).json()
    expect(json).toMatchObject({ processed: 0, duplicates: 0 })
    expect(db._updates).toHaveLength(0)
  })
})
