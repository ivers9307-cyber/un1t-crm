// PAGES.1 — PUT /api/landing-pages/[id]/studios/[locationId]: one studio's
// half of a page's offer (plan, keywords, price, attribution) and whether the
// page is switched on there. Answers the saved row and its readiness.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))

const { createServerClient } = await import('@/lib/supabase')
const { getCurrentUser } = await import('@/lib/auth')
const { PUT } = await import('./route.js')
const { fakeDb, STILL_MANAGER, ORG_ADMIN, PAGE, STILL, HATCH, CLOSED, jsonRequest } = await import('../../../../../../../tests/helpers/landing-pages-fixtures.js')

const save = (id, locationId, body) => PUT(
  jsonRequest(`/api/landing-pages/${id}/studios/${locationId}`, 'PUT', body),
  { params: Promise.resolve({ id, locationId }) },
)
const rowOf = (db, id, loc) => db.state.landing_page_studios.find((r) => r.page_id === id && r.location_id === loc)

let db
beforeEach(() => {
  vi.clearAllMocks()
  db = fakeDb()
  createServerClient.mockReturnValue(db)
  getCurrentUser.mockResolvedValue(ORG_ADMIN)
})

describe('PUT /api/landing-pages/[id]/studios/[locationId]', () => {
  it('parses offer with the page type schema, refuses an unknown key, 404s a location not on the page', async () => {
    const ok = await save(PAGE.trial, STILL, {
      enabled: true,
      offer: { membership_id: 'm2', plan_code: 'p2', price_cents: 4900, product_name: 'Reset' },
      attribution: { tag: 'stillorgan-trial', lead_source: 'meta_trial' },
      sort_order: 2,
    })
    expect(ok.status).toBe(200)
    const { data } = await ok.json()
    expect(data.readiness).toEqual({ ready: true, reason: 'ready' })
    expect(data.row.public_path).toBe('stillorgan')
    expect(data.row).toMatchObject({ location_id: STILL, name: 'UN1T Stillorgan', enabled: true, sort_order: 2, offer: { plan_code: 'p2' } })
    expect(JSON.stringify(data)).not.toContain('branch_id')
    expect(rowOf(db, PAGE.trial, STILL)).toMatchObject({ offer: { membership_id: 'm2', price_cents: 4900 }, attribution: { tag: 'stillorgan-trial' }, updated_by: ORG_ADMIN.id })

    const unknown = await save(PAGE.trial, STILL, { enabled: true, offer: { class_keywords: '50+' }, attribution: {} })
    expect(unknown.status).toBe(400)
    expect((await unknown.json()).issues.length).toBeGreaterThan(0)

    const badAttribution = await save(PAGE.trial, STILL, { enabled: true, offer: {}, attribution: { campaign: 'x' } })
    expect(badAttribution.status).toBe(400)

    const notOnPage = await save(PAGE.trial, CLOSED, { enabled: true, offer: {}, attribution: {} })
    expect(notOnPage.status).toBe(404)
    expect(await notOnPage.json()).toEqual({ success: false, error: 'not_found' })
    expect(rowOf(db, PAGE.trial, STILL).offer.membership_id).toBe('m2')
  })

  it('answers needs_plan for a row it saved without a plan', async () => {
    const res = await save(PAGE.trial, HATCH, { enabled: true, offer: {}, attribution: {} })
    expect((await res.json()).data.readiness).toEqual({ ready: false, reason: 'needs_plan' })
  })

  it('a studio manager is 403 on an all-studios page, even on their own studio\'s row', async () => {
    getCurrentUser.mockResolvedValue(STILL_MANAGER)
    expect((await save(PAGE.trial, STILL, { enabled: false, offer: {}, attribution: {} })).status).toBe(403)
    expect((await save(PAGE.corp, HATCH, { enabled: false, offer: {}, attribution: {} })).status).toBe(404)
    expect(db.writes('landing_page_studios')).toEqual([])
  })

  it('a page with no offer has no studio half to edit', async () => {
    db.state.landing_pages.find((p) => p.id === PAGE.fiftyplus).offer_type = 'none'
    const res = await save(PAGE.fiftyplus, STILL, { enabled: true, offer: {}, attribution: {} })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'no_offer' })
  })

  it('a one-studio page has one row: any other studio is a 404, even one the page holds a stray row for', async () => {
    db.state.landing_page_studios.push({ page_id: PAGE.fiftyplus, location_id: HATCH, enabled: false, offer: {}, attribution: {}, sort_order: 1 })
    const res = await save(PAGE.fiftyplus, HATCH, { enabled: true, offer: {}, attribution: {} })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ success: false, error: 'not_found' })
    expect(db.writes('landing_page_studios')).toEqual([])
    expect((await save(PAGE.fiftyplus, STILL, { enabled: true, offer: { class_keywords: '50+' }, attribution: {} })).status).toBe(200)
  })

  it('a studio page\'s one row is editable by its studio\'s editor', async () => {
    getCurrentUser.mockResolvedValue(STILL_MANAGER)
    const res = await save(PAGE.stillorgan, STILL, {
      enabled: true, offer: { membership_id: 'm2', plan_code: 'p2', price_cents: 4500 }, attribution: { tag: 'stillorgan-trial' },
    })
    expect(res.status).toBe(200)
    expect(rowOf(db, PAGE.stillorgan, STILL)).toMatchObject({
      offer: { membership_id: 'm2', plan_code: 'p2', price_cents: 4500 }, attribution: { tag: 'stillorgan-trial' }, updated_by: STILL_MANAGER.id,
    })
    expect((await res.json()).data.readiness).toEqual({ ready: true, reason: 'ready' })
    // Its only row is its studio's: another studio is a 404.
    expect((await save(PAGE.stillorgan, HATCH, { enabled: true, offer: {}, attribution: {} })).status).toBe(404)
  })

  it('UN1TWRITE.18: a priced free-class funnel at a un1t.online studio is refused; free there, or priced at Glofox, saves', async () => {
    const hatch = db.state.landing_pages.find((p) => p.id === PAGE.hatch)
    hatch.offer_type = 'class_funnel'
    hatch.blocks = [{ id: 'cf', type: 'class_funnel', heading: 'Book a class' }]
    const priced = await save(PAGE.hatch, HATCH, { enabled: true, offer: { price_cents: 1500 }, attribution: {} })
    expect(priced.status).toBe(400)
    expect((await priced.json()).error).toBe('Paid intros are not available at a un1t.online studio: anything paid goes through un1t.online checkout.')
    expect(db.writes('landing_page_studios')).toEqual([])

    expect((await save(PAGE.hatch, HATCH, { enabled: true, offer: { price_cents: 0, timetable: 'Mon 09:00 Strength' }, attribution: {} })).status).toBe(200)

    const still = db.state.landing_pages.find((p) => p.id === PAGE.stillorgan)
    still.offer_type = 'class_funnel'
    still.blocks = [{ id: 'cf2', type: 'class_funnel' }]
    expect((await save(PAGE.stillorgan, STILL, { enabled: true, offer: { trial_membership_id: 'tm', trial_plan_code: 'tp', price_cents: 1500 }, attribution: {} })).status).toBe(200)
  })
})
