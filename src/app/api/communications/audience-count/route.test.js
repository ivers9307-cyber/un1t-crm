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

import { POST } from './route'
import { createServerClient } from '@/lib/supabase'

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

  it('channel=email returns count + inactivity-suppressed exclusion count (EMAIL-HYGIENE.1)', async () => {
    createServerClient.mockReturnValue(fakeCountDb(10, 3))
    const res = await POST(reqWith({ location_id: 'loc', audience_filter: { logic: 'and', filters: [] }, channel: 'email' }))
    const json = await res.json()
    expect(json).toEqual({ success: true, count: 10, suppressed: 3 })
  })

  it('channel=whatsapp returns reachable + excluded breakdown', async () => {
    const res = await POST(reqWith({ location_id: 'loc', audience_filter: { logic: 'and', filters: [] }, channel: 'whatsapp' }))
    const json = await res.json()
    expect(json).toEqual({
      success: true, count: 10, reachable: 6,
      excluded: { no_number: 3, no_consent: 2, opted_out: 1, undeliverable: 0 },
    })
  })
})
