// Route tests for GET /api/bridge/inbody/pending (security audit W2-H / M1).
//
// THE LEAK guarded here: inbody_webhook_events has NO per-row location column
// set at capture time, so before the fix this route handed EVERY location's
// unprocessed events (member phone `tel_hp`) to ANY bridge token. The fix
// scopes to the accounts configured for the bridge's location.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/bridge-auth', () => ({ verifyBridgeToken: vi.fn() }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn() }))

import { GET } from './route.js'
import { createServerClient } from '@/lib/supabase'
import { verifyBridgeToken } from '@/lib/bridge-auth'

// Two locations, each with its own InBody account. loc-A owns account "accta".
// Accounts are stored canonicalised (lowercase) — see the webhook capture +
// migration 346 — so fixtures mirror that.
const LOCATIONS = {
  'loc-A': { settings: { inbody: { accounts: ['accta'] } } },
  'loc-B': { settings: { inbody: { accounts: ['acctb'] } } },
  'loc-none': { settings: {} },
}

// Events spanning both accounts. loc-A's bridge must only ever see accta rows.
const EVENTS = [
  { id: 'e-A1', account: 'accta', tel_hp: '0851111111', test_datetime: '20260101100000', processed: false },
  { id: 'e-B1', account: 'acctb', tel_hp: '0852222222', test_datetime: '20260101110000', processed: false },
  { id: 'e-A2', account: 'accta', tel_hp: 'not-a-phone', test_datetime: '20260101120000', processed: false },
]

function makeDb() {
  return {
    from(table) {
      if (table === 'locations') {
        return {
          select: () => ({
            eq: (_c, id) => ({ maybeSingle: () => Promise.resolve({ data: LOCATIONS[id] || null, error: null }) }),
          }),
        }
      }
      if (table === 'inbody_webhook_events') {
        // Capture the account filter so the query respects .in('account', [...]).
        const state = { accounts: null }
        const b = {
          select: () => b,
          eq: () => b,
          in: (_col, vals) => { state.accounts = vals; return b },
          not: () => b,
          order: () => b,
          limit: () => {
            const rows = EVENTS.filter(
              (e) => !e.processed && (!state.accounts || state.accounts.includes(e.account)),
            )
            return Promise.resolve({ data: rows, error: null })
          },
        }
        return b
      }
      return {}
    },
  }
}

function reqWithAuth() { return { headers: { get: () => 'Bearer bbr_x' } } }

beforeEach(() => {
  vi.clearAllMocks()
  createServerClient.mockReturnValue(makeDb())
})

describe('GET /api/bridge/inbody/pending — location scoping', () => {
  it('401s without a valid bridge token', async () => {
    verifyBridgeToken.mockResolvedValue(null)
    const res = await GET(reqWithAuth())
    expect(res.status).toBe(401)
  })

  it('a bridge for location A does NOT receive location B pending events', async () => {
    verifyBridgeToken.mockResolvedValue({ bridgeId: 'br-A', locationId: 'loc-A' })
    const res = await GET(reqWithAuth())
    const json = await res.json()
    expect(json.ok).toBe(true)
    const ids = json.pending.map((p) => p.event_id)
    expect(ids).toContain('e-A1')
    expect(ids).not.toContain('e-B1') // ← the leak: another location's event
    // e-A2 is dropped: non-phone tel_hp is not a valid usertoken.
    expect(ids).not.toContain('e-A2')
  })

  it('returns an EMPTY queue for a location with no InBody accounts configured', async () => {
    verifyBridgeToken.mockResolvedValue({ bridgeId: 'br-none', locationId: 'loc-none' })
    const res = await GET(reqWithAuth())
    const json = await res.json()
    expect(json.ok).toBe(true)
    expect(json.pending).toEqual([])
  })
})
