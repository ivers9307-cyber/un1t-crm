// COMMSFIX.B.7 — POST /api/whatsapp/broadcasts rejects an invalid audience
// filter at save time (mirrors the SMS route test).

import { describe, it, expect, vi, beforeEach } from 'vitest'

let inserted = []
// TZ.4 — a drip with no send_window_tz takes the studio's zone (locations.timezone).
let studioZone = { timezone: 'Europe/Dublin' }
const fakeDb = {
  // GATES-3 (a) — the create reads the template first (same-studio check).
  from: (table) => table === 'locations' ? ({
    select: () => ({ eq: (_c, id) => ({ maybeSingle: async () => (studioZone.error
      ? { data: null, error: studioZone.error }
      : { data: { id, timezone: studioZone.timezone }, error: null }) }) }),
  }) : table === 'whatsapp_templates' ? ({
    select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { id: 't', location_id: 'loc-1' }, error: null }) }) }),
  }) : ({
    insert: (row) => {
      inserted.push(row)
      return { select: () => ({ single: () => Promise.resolve({ data: { id: 'wa-new', ...row }, error: null }) }) }
    },
  }),
}

vi.mock('@/lib/supabase', () => ({ createServerClient: () => fakeDb }))
vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(async () => ({ id: 'u1', activeLocation: { id: 'loc-1' } })),
  assertLocationAccess: vi.fn(() => null),
  getUserLocationIds: vi.fn(() => ['loc-1']),
}))
vi.mock('@/lib/permissions', () => ({
  hasPermissionAtAnyLocation: () => true,
  hasPermissionForLocation: () => true,
}))
vi.mock('@/lib/validate', () => ({
  validateBody: vi.fn(async (req) => ({ ok: true, data: await req.json() })),
}))

import { POST } from './route.js'
import { resetLocationZoneCache } from '@/lib/location-time'

function post(body) {
  return POST({ json: async () => body })
}

const base = { name: 'WA blast', template_id: '00000000-0000-0000-0000-00000000000t', location_id: 'loc-1' }

beforeEach(() => { inserted = [] })

describe('whatsapp broadcasts POST — audience filter validated at save time (B7)', () => {
  it('rejects an OR + event filter with a 400 carrying the library message', async () => {
    const res = await post({
      ...base,
      audience_filter: {
        logic: 'or',
        filters: [
          { field: 'event_registration', op: 'eq', value: 'evt-1' },
          { field: 'pipeline_stage_slug', op: 'eq', value: 'member' },
        ],
      },
    })
    expect(res.status).toBe(400)
    expect(inserted).toHaveLength(0)
    const json = await res.json()
    expect(json.error).toMatch(/OR logic is not supported together with tag, event or studio-list filters/)
  })

  it('rejects an unknown field with a 400', async () => {
    const res = await post({
      ...base,
      audience_filter: { logic: 'and', filters: [{ field: 'nope', op: 'eq', value: 'x' }] },
    })
    expect(res.status).toBe(400)
    expect(inserted).toHaveLength(0)
  })

  it('still creates a broadcast with a valid filter', async () => {
    const res = await post({
      ...base,
      audience_filter: { logic: 'and', filters: [{ field: 'glofox_membership_status', op: 'eq', value: 'trial' }] },
    })
    const json = await res.json()
    expect(json.success).toBe(true)
    expect(inserted).toHaveLength(1)
  })

  // C120 GATES-3 (e) — a send-now drip is a draft; /send starts it.
  it('creates an unscheduled drip as a draft, never straight into sending', async () => {
    const res = await post({ ...base, audience_filter: { logic: 'and', filters: [] }, delivery_mode: 'drip' })
    expect((await res.json()).success).toBe(true)
    expect(inserted[0]).toMatchObject({ status: 'draft', delivery_mode: 'drip', daily_cap: 500 })
  })

  it('a scheduled drip is still created as scheduled', async () => {
    const at = new Date(Date.now() + 3600e3).toISOString()
    await post({ ...base, audience_filter: { logic: 'and', filters: [] }, delivery_mode: 'drip', status: 'scheduled', scheduled_at: at })
    expect(inserted[0]).toMatchObject({ status: 'scheduled', scheduled_at: at })
  })
})

describe('POST /api/whatsapp/broadcasts — TZ.4 drip window zone', () => {
  const drip = { ...base, audience_filter: { logic: 'and', filters: [] }, delivery_mode: 'drip' }
  beforeEach(() => {
    inserted = []
    studioZone = { timezone: 'Europe/Dublin' }
    resetLocationZoneCache()
  })

  it('a Dublin studio still stores Europe/Dublin (byte-identical)', async () => {
    await post(drip)
    expect(inserted[0].send_window_tz).toBe('Europe/Dublin')
  })

  it("no send_window_tz: the window takes the studio's own zone", async () => {
    studioZone = { timezone: 'America/New_York' }
    await post(drip)
    expect(inserted[0].send_window_tz).toBe('America/New_York')
  })

  it('a NULL studio zone falls back to Europe/Dublin (the column floor)', async () => {
    studioZone = { timezone: null }
    await post(drip)
    expect(inserted[0].send_window_tz).toBe('Europe/Dublin')
  })

  it('an explicit send_window_tz is kept (canonicalised), and the studio is not read', async () => {
    studioZone = { error: { message: 'must not be read' } }
    await post({ ...drip, send_window_tz: 'Australia/Sydney' })
    expect(inserted[0].send_window_tz).toBe('Australia/Sydney')
  })

  it('an invalid or fixed-offset send_window_tz is refused, never stored', async () => {
    for (const tz of ['Mars/Olympus', '+05:30']) {
      const res = await post({ ...drip, send_window_tz: tz })
      expect(res.status).toBe(400)
    }
    expect(inserted).toEqual([])
  })

  it("an unreadable studio zone refuses the drip (503) rather than guessing Dublin", async () => {
    studioZone = { error: { message: 'connection reset' } }
    const res = await post(drip)
    expect(res.status).toBe(503)
    expect(inserted).toEqual([])
  })

  it('a blast never reads the zone and stores no window', async () => {
    studioZone = { error: { message: 'must not be read' } }
    const res = await post({ ...base, audience_filter: { logic: 'and', filters: [] } })
    expect((await res.json()).success).toBe(true)
    expect(inserted[0]).not.toHaveProperty('send_window_tz')
  })
})
