import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(async () => ({ id: 'u1' })),
  assertLocationAccess: vi.fn(() => null),
}))
vi.mock('@/lib/validate', () => ({
  validateBody: vi.fn(async (req) => ({ ok: true, data: await req.json() })),
}))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/whatsapp', () => ({
  computeWhatsAppReachabilitySummary: vi.fn(async () => ({
    matched: 10, reachable: 6, excluded: { no_number: 3, no_consent: 2, opted_out: 1, undeliverable: 0 },
  })),
}))
// Channel-agnostic path resolves the filter then awaits a { count } builder.
vi.mock('@/lib/audience-filter', () => ({
  applyAudienceFilterAsync: vi.fn(async ({ query }) => ({ query })),
}))
// COMMSFIX.B.5 — the email branch counts eligibility through the SEND
// PATH's builder (view + loc_email_marketing + email_status + suppression),
// so the composer number equals what populate would enrol.
vi.mock('@/lib/postmark', () => ({
  buildAudienceQueryAsync: vi.fn(async () => ({
    query: { then: (resolve) => resolve({ count: 2300, error: null }) },
  })),
}))
// FILTER-B.8 — the shared per-channel eligibility builder (delegates to the
// SEND builder for each channel). The preview route calls the same function,
// which is what makes preview == count == send true by construction.
vi.mock('@/lib/audience-eligibility', () => ({
  buildEligibleAudienceQuery: vi.fn(async () => ({
    query: { then: (resolve) => resolve({ count: 2300, error: null }) },
  })),
}))

import { POST } from './route'
import { createServerClient } from '@/lib/supabase'
import { buildEligibleAudienceQuery } from '@/lib/audience-eligibility'

function reqWith(body) { return { json: async () => body } }
// Accepts one count per awaited query, in order (last one repeats) —
// the email path runs a second count for the inactivity-suppressed
// exclusions (EMAIL-HYGIENE.1).
function fakeCountDb(...counts) {
  const remaining = [...counts]
  const makeBuilder = () => new Proxy({}, {
    get(_, prop) {
      if (prop === 'then') {
        const count = remaining.length > 1 ? remaining.shift() : remaining[0]
        return (resolve) => resolve({ count, error: null })
      }
      return function chain() { return this }
    },
  })
  return { from: () => makeBuilder() }
}

beforeEach(() => { createServerClient.mockReturnValue(fakeCountDb(10)) })

describe('audience-count POST', () => {
  it('default (no channel) returns just count', async () => {
    const res = await POST(reqWith({ location_id: 'loc', audience_filter: { logic: 'and', filters: [] } }))
    const json = await res.json()
    expect(json).toEqual({ success: true, count: 10 })
  })

  // COMMSFIX.B.5 — the email count is now SEND-PARITY: `count` is the number
  // populate would actually enrol (via buildAudienceQueryAsync), `matched` is
  // the filter-only view count, and `excluded` breaks down the gap. The old
  // response counted raw contacts with no consent/status gates (overstated
  // ~2.5x) and its suppressed sub-count read the retired GLOBAL
  // contacts.email_marketing column. `suppressed` stays top-level for
  // back-compat; the view sub-counts run in order matched → not_opted_in →
  // bounced_or_complained → suppressed (fakeCountDb yields in call order).
  it('channel=email counts through the send-path builder and returns the will-receive number', async () => {
    createServerClient.mockReturnValue(fakeCountDb(4900, 1200, 24, 300))
    const filter = { logic: 'and', filters: [] }
    const res = await POST(reqWith({ location_id: 'loc', audience_filter: filter, channel: 'email' }))
    const json = await res.json()
    expect(json).toEqual({
      success: true,
      count: 2300,          // eligible / will receive — from the send-path builder
      matched: 4900,        // filter-only
      suppressed: 300,      // back-compat top-level key
      excluded: { not_opted_in: 1200, bounced_or_complained: 24, suppressed: 300 },
    })
    // FILTER-B.8 — the eligible number must come from the shared per-channel
    // send builder with a head:true count, NOT a query spelled out here.
    expect(buildEligibleAudienceQuery).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'email', filter, locationId: 'loc',
      columns: 'id', selectOpts: { count: 'exact', head: true },
    }))
  })

  it('channel=email surfaces a send-path count error as a 400', async () => {
    createServerClient.mockReturnValue(fakeCountDb(4900, 1200, 24, 300))
    buildEligibleAudienceQuery.mockResolvedValueOnce({
      query: { then: (resolve) => resolve({ count: null, error: { message: 'boom' } }) },
    })
    const res = await POST(reqWith({ location_id: 'loc', audience_filter: { logic: 'and', filters: [] }, channel: 'email' }))
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.success).toBe(false)
    expect(json.error).toMatch(/boom/)
  })

  // TWILIO-RETIRE.1 — the SMS branch left with the channel; the route's
  // schema (enforced by validateBody, mocked in this file) no longer admits
  // channel 'sms'.

  it('channel=whatsapp returns reachable + excluded breakdown', async () => {
    const res = await POST(reqWith({ location_id: 'loc', audience_filter: { logic: 'and', filters: [] }, channel: 'whatsapp' }))
    const json = await res.json()
    expect(json).toEqual({
      success: true, count: 10, reachable: 6,
      excluded: { no_number: 3, no_consent: 2, opted_out: 1, undeliverable: 0 },
    })
  })
})

// ── FILTER-B.8 — the count and the preview must share ONE query path ──
//
// The email branch already delegated to the send builder. The (since retired)
// SMS branch did not: it re-spelled its send gates inline — the exact shape
// that lets a preview and a send drift apart. The count goes through
// buildEligibleAudienceQuery, which delegates to the per-channel SEND builder,
// and the preview route calls the same function.
describe('audience-count — the will-receive number comes from the shared send builder', () => {
  it('channel=email delegates to buildEligibleAudienceQuery', async () => {
    createServerClient.mockReturnValue(fakeCountDb(4900, 1200, 24, 300))
    const filter = { logic: 'and', filters: [] }
    await POST(reqWith({ location_id: 'loc', audience_filter: filter, channel: 'email' }))
    expect(buildEligibleAudienceQuery).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'email', filter, locationId: 'loc',
      columns: 'id', selectOpts: { count: 'exact', head: true },
    }))
  })
})
