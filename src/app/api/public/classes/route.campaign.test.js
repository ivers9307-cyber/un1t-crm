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
  return { ...actual, resolvePublicPageRequest: vi.fn() }
})

// OPENWEEK.1 — the promo row and the window's read have their own tests.
const ow = vi.hoisted(() => ({ promoRead: vi.fn(), listOw: vi.fn(), creditLast: vi.fn() }))
vi.mock('@/lib/glofox-credit-window', async (importOriginal) => ({ ...(await importOriginal()), readPromoCreditLastDay: ow.creditLast }))
vi.mock('@/lib/corp-promos-db', () => ({ readCorpPromo: ow.promoRead }))
vi.mock('@/lib/open-week-claim', () => ({ readOpenWeekClasses: ow.listOw }))

import { GET } from './route.js'
import { createServerClient } from '@/lib/supabase'
import { fetchUpcomingEvents } from '@/lib/glofox'
import { resolvePublicPageRequest } from '@/lib/landing-pages'
import { checkRateLimit } from '@/lib/rate-limit'
import { readUn1tWriteSettings } from '@/lib/un1t-online-settings'

// The studio page the `path` names, as the resolver answers it (its own tests live beside it).
let blocks = []
const studioOk = () => ({
  ok: true, pageId: 'p-s', page: { id: 'p-s', slug: 'stillorgan', kind: 'studio' }, studioRow: {},
  locationId: 'loc-1', publicPath: 'stillorgan', blocks, attribution: {}, terms: {},
})
function makeDb() {
  const q = {
    select() { return q },
    eq() { return q },
    maybeSingle: async () => ({ data: null, error: null }),
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
  resolvePublicPageRequest.mockReset()
  resolvePublicPageRequest.mockImplementation(async () => studioOk())
  ow.promoRead.mockResolvedValue({ ok: true, promo: null })
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

  it('a missing studio page under a campaign is not configured, not "no classes"', async () => {
    resolvePublicPageRequest.mockResolvedValueOnce({ ok: false, reason: 'not_found' })
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
  locationId: 'loc-1', publicPath: 'stillorgan', blocks: [block], attribution: { tag: 't', lead_source: 'l' }, terms: {}, ...extra,
})

describe('GET /api/public/classes — page (PAGES.1)', () => {
  // CLASSFIRST.1 — the class before the details on /trial and /corp.
  it('a paid_trial page lists the studio\'s whole visible timetable over 14 days, configured, with the blip flag', async () => {
    resolvePublicPageRequest.mockResolvedValueOnce(pageOk({ type: 'paid_trial', heading: 'The 14 Day Reset' }, { page: { id: 'p-t', slug: 'trial', offer_type: 'paid_trial' } }))
    fetchUpcomingEvents.mockResolvedValueOnce({ ok: true, events: EVENTS })
    const body = await (await get('page=trial&studio=stillorgan')).json()
    expect(body.data.classes.map((c) => c.event_id)).toEqual(['a', 'b'])
    expect(body.data.campaign).toEqual({ configured: true, timetable_unavailable: false })
    expect(body.data.terms).toEqual({ required: false })
    const opts = fetchUpcomingEvents.mock.calls[0][1]
    expect(opts.end - opts.start).toBe(14 * 86400)
  })
  it('a promo_credits page lists the same way, and a failed read is the blip, never "no classes"', async () => {
    resolvePublicPageRequest.mockResolvedValueOnce(pageOk({ type: 'corp_promo' }, { page: { id: 'p-c', slug: 'corp', offer_type: 'promo_credits' } }))
    fetchUpcomingEvents.mockResolvedValueOnce({ ok: false })
    const body = await (await get('page=corp&studio=hatch-street')).json()
    expect(body.data.classes).toEqual([])
    expect(body.data.campaign).toEqual({ configured: true, timetable_unavailable: true })
  })
  it('a page with no offer still lists nothing', async () => {
    resolvePublicPageRequest.mockResolvedValueOnce(pageOk({ type: 'hero' }, { page: { id: 'p-n', slug: 'about', offer_type: 'none' } }))
    const body = await (await get('page=about')).json()
    expect(body.data.classes).toEqual([])
    expect(fetchUpcomingEvents).not.toHaveBeenCalled()
  })

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

describe('GET /api/public/classes — open week (OPENWEEK.1)', () => {
  const OW = { key: 'hatch-open-week', live: true, kind: 'open_week', windowStartsOn: '2026-11-23', windowEndsOn: '2026-11-30', maxClasses: 5, maxPerDay: 1 }
  const owPage = () => pageOk({ type: 'corp_promo', promo_key: 'hatch-open-week' }, { page: { id: 'p-ow', slug: 'openweek', offer_type: 'promo_credits' }, locationId: 'loc-h', publicPath: 'hatch-street' })

  it("lists only the window's classes and says what the picker may take", async () => {
    resolvePublicPageRequest.mockResolvedValueOnce(owPage())
    ow.promoRead.mockResolvedValueOnce({ ok: true, promo: OW })
    ow.listOw.mockResolvedValueOnce({ ok: true, classes: [{ event_id: 'un1t:a', name: 'A', starts_at: '2026-11-24T07:00:00.000Z', day: '2026-11-24' }] })
    const body = await (await get('page=openweek&studio=hatch-street')).json()
    expect(ow.promoRead).toHaveBeenCalledWith(expect.anything(), { locationId: 'loc-h', key: 'hatch-open-week' })
    expect(body.data.classes.map((c) => c.event_id)).toEqual(['un1t:a'])
    expect(body.data.open_week).toEqual({ state: 'open', max_classes: 5, max_per_day: 1, starts_on: '2026-11-23', ends_on: '2026-11-30' })
    expect(body.data.campaign).toEqual({ configured: true, timetable_unavailable: false })
    expect(fetchUpcomingEvents).not.toHaveBeenCalled()
  })

  it('after the week lists nothing and says so; a failed read is the blip', async () => {
    resolvePublicPageRequest.mockResolvedValueOnce(owPage())
    ow.promoRead.mockResolvedValueOnce({ ok: true, promo: OW })
    ow.listOw.mockResolvedValueOnce({ ok: false, code: 'over' })
    let body = await (await get('page=openweek&studio=hatch-street')).json()
    expect(body.data.classes).toEqual([])
    expect(body.data.open_week.state).toBe('over')
    resolvePublicPageRequest.mockResolvedValueOnce(owPage())
    ow.promoRead.mockResolvedValueOnce({ ok: true, promo: OW })
    ow.listOw.mockResolvedValueOnce({ ok: false, code: 'timetable_unavailable' })
    body = await (await get('page=openweek&studio=hatch-street')).json()
    expect(body.data.campaign).toEqual({ configured: true, timetable_unavailable: true })
  })

  it('a normal promo page carries no open_week', async () => {
    resolvePublicPageRequest.mockResolvedValueOnce(pageOk({ type: 'corp_promo', promo_key: 'hatch-3-free' }, { page: { id: 'p-c', slug: 'corp', offer_type: 'promo_credits' } }))
    fetchUpcomingEvents.mockResolvedValueOnce({ ok: true, events: EVENTS })
    const body = await (await get('page=corp&studio=hatch-street')).json()
    expect(body.data).not.toHaveProperty('open_week')
    expect(ow.creditLast).not.toHaveBeenCalled()
  })

  // CREDITWINDOW.1 — a Glofox promo lists only what its plan's credits can book.
  it("a Glofox promo page leaves out classes after the plan's last credit day", async () => {
    const GP = { key: 'stillorgan-newstart', live: true, kind: 'promo', platform: 'glofox', glofox: { membershipId: 'm', planCode: 'p', planName: null } }
    const gPage = () => pageOk({ type: 'corp_promo', promo_key: 'stillorgan-newstart' }, { page: { id: 'p-g', slug: 'newstart', offer_type: 'promo_credits' } })
    const list = async (lastDay) => {
      resolvePublicPageRequest.mockResolvedValueOnce(gPage())
      ow.promoRead.mockResolvedValueOnce({ ok: true, promo: GP })
      ow.creditLast.mockResolvedValueOnce(lastDay)
      fetchUpcomingEvents.mockResolvedValueOnce({ ok: true, events: EVENTS })
      return (await (await get('page=newstart&studio=stillorgan')).json()).data.classes.map((c) => c.event_id)
    }
    // Both classes are on 2100-01-01.
    expect(await list('2099-12-31')).toEqual([])
    expect(await list('2100-01-01')).toEqual(['a', 'b'])
    expect(await list(null)).toEqual(['a', 'b'])
    expect(ow.creditLast).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ promo: GP, zone: 'Europe/Dublin' }))
  })
})
