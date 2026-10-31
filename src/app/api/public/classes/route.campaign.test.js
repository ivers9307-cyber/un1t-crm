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

vi.mock('@/lib/landing-pages', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, resolvePublicPageRequest: vi.fn(actual.resolvePublicPageRequest), studioTermsCopy: vi.fn(async () => ({})) }
})

import { GET } from './route.js'
import { createServerClient } from '@/lib/supabase'
import { fetchUpcomingEvents } from '@/lib/glofox'
import { resolvePublicPageRequest } from '@/lib/landing-pages'
import { checkRateLimit } from '@/lib/rate-limit'
import { readUn1tWriteSettings } from '@/lib/un1t-online-settings'

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
  fetchUpcomingEvents.mockReset() // a queued once-value from a test that never fetched must not leak
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
    expect(body.data.campaign).toEqual({ configured: true, timetable_unavailable: false })
    const opts = fetchUpcomingEvents.mock.calls[0][1]
    expect(opts.end - opts.start).toBe(14 * 86400)
  })

  it('unknown campaign resolves null: no classes, not configured', async () => {
    blocks = [{ type: 'class_funnel' }]
    fetchUpcomingEvents.mockResolvedValueOnce({ ok: true, events: EVENTS })
    const body = await (await get('path=stillorgan&campaign=50plus')).json()
    expect(body.data.classes).toEqual([])
    expect(body.data.campaign).toEqual({ configured: false, timetable_unavailable: false })
    expect(fetchUpcomingEvents).not.toHaveBeenCalled()
  })

  it('a block with no trial pair still lists its classes but is not configured', async () => {
    blocks = [{ type: 'campaign_funnel', campaign: '50plus', class_keywords: '50+' }]
    fetchUpcomingEvents.mockResolvedValueOnce({ ok: true, events: EVENTS })
    const body = await (await get('path=stillorgan&campaign=50plus')).json()
    expect(body.data.classes.map((c) => c.event_id)).toEqual(['a'])
    expect(body.data.campaign).toEqual({ configured: false, timetable_unavailable: false })
  })

  it('a failed timetable read is flagged, not "no classes"', async () => {
    blocks = [{ type: 'campaign_funnel', campaign: '50plus', class_keywords: '50+', trial_membership_id: 'm', trial_plan_code: 'p' }]
    fetchUpcomingEvents.mockResolvedValueOnce({ ok: false })
    const body = await (await get('path=stillorgan&campaign=50plus')).json()
    expect(body.data.classes).toEqual([])
    expect(body.data.campaign).toEqual({ configured: true, timetable_unavailable: true })
  })

  it('a good read carries timetable_unavailable false', async () => {
    blocks = [{ type: 'campaign_funnel', campaign: '50plus', class_keywords: '50+', trial_membership_id: 'm', trial_plan_code: 'p' }]
    fetchUpcomingEvents.mockResolvedValueOnce({ ok: true, events: EVENTS })
    const body = await (await get('path=stillorgan&campaign=50plus')).json()
    expect(body.data.campaign).toEqual({ configured: true, timetable_unavailable: false })
  })

  it('a missing landing row under a campaign is not configured, not "no classes"', async () => {
    createServerClient.mockReturnValue({ from: () => ({ select() { return this }, eq() { return this }, maybeSingle: async () => ({ data: null, error: null }) }) })
    const body = await (await get('path=stillorgan&campaign=50plus')).json()
    expect(body.data.classes).toEqual([])
    expect(body.data.campaign).toEqual({ configured: false, timetable_unavailable: false })
  })

  it('no campaign param keeps the full list and no campaign key', async () => {
    blocks = [{ type: 'campaign_funnel', campaign: '50plus', class_keywords: '50+' }]
    fetchUpcomingEvents.mockResolvedValueOnce({ ok: true, events: EVENTS })
    const body = await (await get('path=stillorgan')).json()
    expect(body.data.classes).toHaveLength(2)
    expect(body.data.campaign).toBeUndefined()
  })
})

// PAGES.1 — `?page=<slug>&studio=<path>`: the page's merged offer block (its
// studio row's allow-list and trial pair) decides the list; `campaign` and
// `path` are ignored.
const pageOk = (block, extra = {}) => ({
  ok: true, pageId: 'p-50', page: { id: 'p-50', slug: '50plus', offer_type: 'one_class' }, studioRow: {},
  locationId: 'loc-1', publicPath: 'stillorgan', blocks: [block], attribution: { tag: 't', lead_source: 'l' }, ...extra,
})

describe('GET /api/public/classes — page (PAGES.1)', () => {
  it("lists the campaign page's allow-listed class with ?page=50plus and reports configured", async () => {
    resolvePublicPageRequest.mockResolvedValueOnce(pageOk({ type: 'campaign_funnel', campaign: '50plus', class_keywords: '50+', trial_membership_id: 'm', trial_plan_code: 'p' }))
    fetchUpcomingEvents.mockResolvedValueOnce({ ok: true, events: EVENTS })
    const res = await get('page=50plus&studio=stillorgan&path=hatch-street&campaign=other')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.classes.map((c) => c.event_id)).toEqual(['a'])
    expect(body.data.campaign).toEqual({ configured: true, timetable_unavailable: false })
    expect(resolvePublicPageRequest).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ page: '50plus', studio: 'stillorgan' }))
    expect(checkRateLimit.mock.calls[0][1]).toBe('pubclasses:stillorgan:1.2.3.4')
  })

  it('a page block with no allow-list is not configured and lists nothing', async () => {
    resolvePublicPageRequest.mockResolvedValueOnce(pageOk({ type: 'campaign_funnel', campaign: '50plus', trial_membership_id: 'm', trial_plan_code: 'p' }))
    fetchUpcomingEvents.mockResolvedValueOnce({ ok: true, events: EVENTS })
    const body = await (await get('page=50plus')).json()
    expect(body.data.classes).toEqual([])
    expect(body.data.campaign.configured).toBe(false)
  })

  it('a class_funnel page lists the studio timetable as /welcome does', async () => {
    resolvePublicPageRequest.mockResolvedValueOnce(pageOk({ type: 'class_funnel' }, { page: { id: 'p', slug: 'free', offer_type: 'class_funnel' } }))
    fetchUpcomingEvents.mockResolvedValueOnce({ ok: true, events: EVENTS })
    const body = await (await get('page=free')).json()
    expect(body.data.classes).toHaveLength(2)
  })

  it('a un1t.online page studio gets the terms tick in the studio\'s words', async () => {
    readUn1tWriteSettings.mockResolvedValueOnce({ membershipSource: 'un1t_online', settings: { funnelEnabled: true }, studioName: 'Hatch Street' })
    resolvePublicPageRequest.mockResolvedValueOnce(pageOk({ type: 'campaign_funnel', campaign: '50plus', class_keywords: '50+', trial_membership_id: 'm', trial_plan_code: 'p' }, { publicPath: 'hatch-street' }))
    fetchUpcomingEvents.mockResolvedValueOnce({ ok: true, events: EVENTS })
    const body = await (await get('page=50plus')).json()
    expect(body.data.terms.required).toBe(true)
  })

  it('not_found answers no classes and not configured; studio_required is a 400; unreadable is the timetable blip', async () => {
    resolvePublicPageRequest.mockResolvedValueOnce({ ok: false, reason: 'not_found' })
    let res = await get('page=gone')
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({ classes: [], campaign: { configured: false, timetable_unavailable: false } })

    resolvePublicPageRequest.mockResolvedValueOnce({ ok: false, reason: 'studio_required' })
    res = await get('page=trial')
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ success: false, error: 'studio_required' })

    resolvePublicPageRequest.mockResolvedValueOnce({ ok: false, reason: 'unreadable' })
    res = await get('page=50plus')
    expect((await res.json()).data).toEqual({ classes: [], campaign: { configured: true, timetable_unavailable: true } })
    expect(fetchUpcomingEvents).not.toHaveBeenCalled()
  })
})
