// FIFTYPLUS.1 — GET /api/public/classes?campaign=<key>: the row's
// campaign_funnel block for that key decides the allow-list (and whether the
// page is configured to book); an unknown key answers nothing, never the
// whole timetable. Without the param the response is unchanged.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/rate-limit', () => ({
  getClientIp: vi.fn(() => '1.2.3.4'),
  checkRateLimit: vi.fn(async () => ({ allowed: true })),
  rateLimitResponse: vi.fn(() => Response.json({ success: false }, { status: 429 })),
}))
vi.mock('@/lib/glofox', () => ({
  glofoxCredentialsForLocation: vi.fn(async () => ({ branchId: 'b', apiKey: 'k', apiToken: 't' })),
  missingGlofoxCredentialsForLocation: vi.fn(() => []),
  fetchUpcomingEvents: vi.fn(),
}))
vi.mock('@/lib/location-time', async (importOriginal) => ({
  ...(await importOriginal()),
  getLocationZone: vi.fn(async () => 'Europe/Dublin'),
}))
vi.mock('@/lib/un1t-online-settings', () => ({
  readUn1tWriteSettings: vi.fn(async () => ({ membershipSource: 'glofox', settings: {}, studioName: 'Stillorgan' })),
}))

import { GET } from './route.js'
import { createServerClient } from '@/lib/supabase'
import { fetchUpcomingEvents } from '@/lib/glofox'

let blocks = []
function makeDb() {
  const q = {
    select() { return q },
    eq() { return q },
    maybeSingle: async () => ({ data: { location_id: 'loc-1', public_path: 'stillorgan', blocks }, error: null }),
  }
  return { from: () => q }
}

const EVENTS = [
  { _id: 'a', name: 'THE 50+ CLUB', time_start: 4102444800, size: 12, booked: 2, active: true, private: false },
  { _id: 'b', name: 'S&C', time_start: 4102448400, size: 12, booked: 2, active: true, private: false },
]
const get = (qs) => GET(new Request(`https://crm.example/api/public/classes?${qs}`))

beforeEach(() => {
  vi.clearAllMocks()
  blocks = []
  createServerClient.mockReturnValue(makeDb())
})

describe('GET /api/public/classes — campaign (FIFTYPLUS.1)', () => {
  it('lists only the allow-listed class for a known campaign and says whether it is configured', async () => {
    blocks = [{ type: 'campaign_funnel', campaign: '50plus', class_keywords: '50+', trial_membership_id: 'm', trial_plan_code: 'p' }]
    fetchUpcomingEvents.mockResolvedValueOnce({ ok: true, events: EVENTS })
    const res = await get('path=stillorgan&campaign=50plus')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.classes.map((c) => c.event_id)).toEqual(['a'])
    expect(body.data.campaign).toEqual({ configured: true })
    const opts = fetchUpcomingEvents.mock.calls[0][1]
    expect(opts.end - opts.start).toBe(14 * 86400)
  })

  it('unknown campaign resolves null: no classes, not configured', async () => {
    blocks = [{ type: 'class_funnel' }]
    fetchUpcomingEvents.mockResolvedValueOnce({ ok: true, events: EVENTS })
    const body = await (await get('path=stillorgan&campaign=50plus')).json()
    expect(body.data.classes).toEqual([])
    expect(body.data.campaign).toEqual({ configured: false })
    expect(fetchUpcomingEvents).not.toHaveBeenCalled()
  })

  it('a block with no trial pair still lists its classes but is not configured', async () => {
    blocks = [{ type: 'campaign_funnel', campaign: '50plus', class_keywords: '50+' }]
    fetchUpcomingEvents.mockResolvedValueOnce({ ok: true, events: EVENTS })
    const body = await (await get('path=stillorgan&campaign=50plus')).json()
    expect(body.data.classes.map((c) => c.event_id)).toEqual(['a'])
    expect(body.data.campaign).toEqual({ configured: false })
  })

  it('a missing landing row under a campaign is not configured, not "no classes"', async () => {
    createServerClient.mockReturnValue({ from: () => ({ select() { return this }, eq() { return this }, maybeSingle: async () => ({ data: null, error: null }) }) })
    const body = await (await get('path=stillorgan&campaign=50plus')).json()
    expect(body.data.classes).toEqual([])
    expect(body.data.campaign).toEqual({ configured: false })
  })

  it('no campaign param keeps the full list and no campaign key', async () => {
    blocks = [{ type: 'campaign_funnel', campaign: '50plus', class_keywords: '50+' }]
    fetchUpcomingEvents.mockResolvedValueOnce({ ok: true, events: EVENTS })
    const body = await (await get('path=stillorgan')).json()
    expect(body.data.classes).toHaveLength(2)
    expect(body.data.campaign).toBeUndefined()
  })
})
