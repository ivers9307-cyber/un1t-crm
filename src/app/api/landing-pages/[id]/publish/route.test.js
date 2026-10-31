// PAGES.1 — POST /api/landing-pages/[id]/publish: draft, live, coming soon,
// retired. Live needs a switched-on studio whose offer is ready
// (studioRowReadiness); retired needs a same-site redirect.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))

const { createServerClient } = await import('@/lib/supabase')
const { getCurrentUser } = await import('@/lib/auth')
const { POST } = await import('./route.js')
const { fakeDb, STILL_MANAGER, ORG_ADMIN, PAGE, STILL, HATCH, jsonRequest } = await import('../../../../../../tests/helpers/landing-pages-fixtures.js')

const publish = (id, body) => POST(jsonRequest(`/api/landing-pages/${id}/publish`, 'POST', body), { params: Promise.resolve({ id }) })
const stored = (db, id) => db.state.landing_pages.find((p) => p.id === id)
const rowsOf = (db, id) => db.state.landing_page_studios.filter((r) => r.page_id === id)

let db
beforeEach(() => {
  vi.clearAllMocks()
  db = fakeDb()
  createServerClient.mockReturnValue(db)
  getCurrentUser.mockResolvedValue(ORG_ADMIN)
})

describe('POST /api/landing-pages/[id]/publish', () => {
  it('live is refused with not_ready when no enabled studio row is configured; granted when one is; retired needs redirect_to', async () => {
    stored(db, PAGE.trial).publish_state = 'draft'
    for (const r of rowsOf(db, PAGE.trial)) r.offer = {}
    const refused = await publish(PAGE.trial, { publish_state: 'live' })
    expect(refused.status).toBe(409)
    expect(await refused.json()).toEqual({
      success: false,
      error: 'not_ready',
      studios: [
        { location_id: STILL, name: 'UN1T Stillorgan', reason: 'needs_plan' },
        { location_id: HATCH, name: 'UN1T Hatch Street', reason: 'needs_plan' },
      ],
    })
    expect(stored(db, PAGE.trial).publish_state).toBe('draft')

    rowsOf(db, PAGE.trial)[0].offer = { membership_id: 'm', plan_code: 'p', price_cents: 3900 }
    const granted = await publish(PAGE.trial, { publish_state: 'live' })
    expect(granted.status).toBe(200)
    expect(stored(db, PAGE.trial)).toMatchObject({ publish_state: 'live', redirect_to: null })
    expect(stored(db, PAGE.trial).chrome.was_live).toBe(true)

    const noRedirect = await publish(PAGE.trial, { publish_state: 'retired' })
    expect(noRedirect.status).toBe(400)
    expect(await noRedirect.json()).toMatchObject({ error: 'redirect_required' })

    const retired = await publish(PAGE.trial, { publish_state: 'retired', redirect_to: '/january?studio=stillorgan' })
    expect(retired.status).toBe(200)
    expect(stored(db, PAGE.trial)).toMatchObject({ publish_state: 'retired', redirect_to: '/january?studio=stillorgan' })
  })

  it('retired with redirect_to "//evil.com" is 400', async () => {
    for (const redirect_to of ['//evil.com', '/\\evil.com', 'https://evil.com']) {
      expect((await publish(PAGE.fiftyplus, { publish_state: 'retired', redirect_to })).status).toBe(400)
    }
    expect(stored(db, PAGE.fiftyplus).publish_state).toBe('live')
  })

  it('a one-studio page whose primary is switched off is not ready, even when its offer is ready', async () => {
    stored(db, PAGE.fiftyplus).publish_state = 'draft'
    rowsOf(db, PAGE.fiftyplus)[0].enabled = false
    const res = await publish(PAGE.fiftyplus, { publish_state: 'live' })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({
      success: false, error: 'not_ready',
      studios: [{ location_id: STILL, name: 'UN1T Stillorgan', reason: 'switched_off' }],
    })
    expect(stored(db, PAGE.fiftyplus).publish_state).toBe('draft')
  })

  it('a one-studio page judges its primary only: another studio\'s ready row never publishes it', async () => {
    stored(db, PAGE.corp).publish_state = 'draft'
    rowsOf(db, PAGE.corp)[0].offer = {} // the primary (Hatch Street) has no promo
    // A stray ready, switched-on row for another studio (a page made before one-row create).
    db.state.landing_page_studios.push({ page_id: PAGE.corp, location_id: STILL, enabled: true, offer: { promo_key: 'hatch-3-free' }, attribution: {}, sort_order: 1 })
    const res = await publish(PAGE.corp, { publish_state: 'live' })
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: 'not_ready', studios: [{ location_id: HATCH, reason: 'needs_plan' }] })
    expect(stored(db, PAGE.corp).publish_state).toBe('draft')

    rowsOf(db, PAGE.corp)[0].offer = { promo_key: 'hatch-3-free' }
    expect((await publish(PAGE.corp, { publish_state: 'live' })).status).toBe(200)
  })

  it('a un1t.online studio with writes off is no_platform', async () => {
    stored(db, PAGE.trial).publish_state = 'draft'
    rowsOf(db, PAGE.trial)[0].enabled = false
    db.state.locations.find((l) => l.id === HATCH).settings = { un1t_online: { writes_enabled: false } }
    const res = await publish(PAGE.trial, { publish_state: 'live' })
    expect(await res.json()).toMatchObject({ error: 'not_ready', studios: [{ location_id: HATCH, reason: 'no_platform' }] })
  })

  it('draft and coming soon are always allowed; a page with no offer goes live with no studio check', async () => {
    for (const r of rowsOf(db, PAGE.trial)) r.offer = {}
    expect((await publish(PAGE.trial, { publish_state: 'coming_soon' })).status).toBe(200)
    expect((await publish(PAGE.trial, { publish_state: 'draft' })).status).toBe(200)
    expect(stored(db, PAGE.trial).publish_state).toBe('draft')
    stored(db, PAGE.fiftyplus).offer_type = 'none'
    rowsOf(db, PAGE.fiftyplus)[0].enabled = false
    stored(db, PAGE.fiftyplus).publish_state = 'draft'
    expect((await publish(PAGE.fiftyplus, { publish_state: 'live' })).status).toBe(200)
  })

  it('a studio page is read-only until PR3 (any state, 400 studio_page); a viewer who cannot edit is 403; outside the view is 404', async () => {
    for (const body of [{ publish_state: 'retired', redirect_to: '/trial' }, { publish_state: 'draft' }, { publish_state: 'live' }]) {
      const studio = await publish(PAGE.stillorgan, body)
      expect(studio.status).toBe(400)
      expect(await studio.json()).toMatchObject({ error: 'studio_page' })
    }
    expect(db.writes('landing_pages')).toEqual([])

    getCurrentUser.mockResolvedValue(STILL_MANAGER)
    expect((await publish(PAGE.trial, { publish_state: 'draft' })).status).toBe(403)
    expect((await publish(PAGE.corp, { publish_state: 'draft' })).status).toBe(404)
    expect(db.writes('landing_pages')).toEqual([])
  })
})
