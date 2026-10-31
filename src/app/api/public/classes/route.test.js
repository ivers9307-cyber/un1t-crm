// PUBCAP.1 — GET /api/public/classes is anonymous, so its JSON must never carry
// a class capacity figure (Richard's rule: capacity is never surfaced to
// customers — no spots left, size, booked count or "full" flag). The real
// listPublicClasses runs here; only Glofox, the registry read and the database
// are stubbed, so a capacity field reintroduced anywhere in the shaping path
// fails this test.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/rate-limit', () => ({
  getClientIp: vi.fn(() => '1.2.3.4'),
  checkRateLimit: vi.fn(async () => ({ allowed: true })),
  rateLimitResponse: vi.fn(() => Response.json({ success: false }, { status: 429 })),
}))
// The studio page the path names, as the resolver answers it (its own tests live beside it).
vi.mock('@/lib/landing-pages', async (importOriginal) => ({
  ...(await importOriginal()),
  resolvePublicPageRequest: vi.fn(async () => ({
    ok: true, pageId: 'p-s', page: { id: 'p-s', slug: 'stillorgan', kind: 'studio' }, studioRow: {},
    locationId: 'loc-1', publicPath: 'stillorgan', blocks: [], attribution: {}, terms: {},
  })),
}))
vi.mock('@/lib/glofox', () => ({
  glofoxCredentialsForLocation: vi.fn(async () => ({ branchId: 'b', apiKey: 'k', apiToken: 't' })),
  missingGlofoxCredentialsForLocation: vi.fn(() => []),
  fetchUpcomingEvents: vi.fn(),
}))

import { GET } from './route.js'
import { createServerClient } from '@/lib/supabase'
import { fetchUpcomingEvents } from '@/lib/glofox'
import { resolvePublicPageRequest } from '@/lib/landing-pages'

const CAPACITY_KEY = /spot|capacity|size|booked|remaining|left|place|seat|full|waiting|limit/i

function makeDb() {
  const q = {
    select() { return q },
    eq() { return q },
    maybeSingle: async () => ({ data: null, error: null }),
  }
  return { from: () => q }
}

function allKeys(value, out = []) {
  if (Array.isArray(value)) value.forEach((v) => allKeys(v, out))
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) { out.push(k); allKeys(v, out) }
  }
  return out
}

beforeEach(() => {
  vi.clearAllMocks()
  createServerClient.mockReturnValue(makeDb())
})

describe('GET /api/public/classes — PUBCAP.1', () => {
  it('returns bookable classes with no capacity field anywhere in the JSON', async () => {
    fetchUpcomingEvents.mockResolvedValueOnce({ ok: true, events: [
      { _id: 'a', name: 'BASE', time_start: 4102444800, size: 12, booked: 9, waiting: 0, active: true, private: false },
      { _id: 'b', name: 'HIIT', time_start: 4102448400, size: 10, booked: 10, waiting: 4, active: true, private: false },
    ] })
    const res = await GET(new Request('https://crm.example/api/public/classes?path=stillorgan'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    // The full class is left out, not flagged.
    expect(body.data.classes.map((c) => c.event_id)).toEqual(['a'])
    const keys = allKeys(body.data.classes)
    expect(keys.length).toBeGreaterThan(0)
    for (const k of keys) expect(k).not.toMatch(CAPACITY_KEY)
    // And no count from the Glofox event leaks through as a value.
    const text = JSON.stringify(body.data.classes)
    for (const n of ['12', '9', '10', '3']) expect(text).not.toMatch(new RegExp(`:\\s*${n}[,}\\]]`))
  })

  it('reads the studio through the studio page the path names, and answers nothing for an unknown or unreadable one', async () => {
    fetchUpcomingEvents.mockResolvedValue({ ok: true, events: [{ _id: 'a', name: 'BASE', time_start: 4102444800, size: 12, booked: 9, active: true, private: false }] })
    await GET(new Request('https://crm.example/api/public/classes?path=stillorgan', { headers: { host: 'www.un1tdublin.com' } }))
    expect(resolvePublicPageRequest).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ legacyPath: 'stillorgan', hostname: 'www.un1tdublin.com' }))
    for (const reason of ['not_found', 'unreadable']) {
      resolvePublicPageRequest.mockResolvedValueOnce({ ok: false, reason })
      const body = await (await GET(new Request('https://crm.example/api/public/classes?path=galway'))).json()
      expect(body).toEqual({ success: true, data: { classes: [] } })
    }
  })
})
