// PAGES.1 — GET /api/landing-pages (the Pages list) and POST (a new campaign
// page). The access rules are canViewPage / canEditPage (landing-pages.js);
// this pins what the routes do with them: who sees which page, who may create
// which kind, the slug refusals, and what a new page is made of.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/host-brand', () => ({
  resolveLocationBrand: vi.fn(async () => ({ companyName: 'UN1T Stillorgan', shortName: 'UN1T', locationName: 'UN1T Stillorgan' })),
  resolveOrgChrome: vi.fn(async () => ({ orgId: 'org', companyName: 'UN1T Group', shortName: 'UN1T', legalName: 'UN1T', studios: [] })),
}))

const { createServerClient } = await import('@/lib/supabase')
const { getCurrentUser } = await import('@/lib/auth')
const { resolveLocationBrand, resolveOrgChrome } = await import('@/lib/host-brand')
const { GET, POST } = await import('./route.js')
const {
  fakeDb, STILL_MANAGER, ORG_ADMIN, MASTER, ORG, STILL, HATCH, CLOSED, PAGE, jsonRequest,
} = await import('../../../../tests/helpers/landing-pages-fixtures.js')

const list = () => new Request('http://localhost/api/landing-pages')
const create = (body) => jsonRequest('/api/landing-pages', 'POST', body)
const NEW_ONE = { title: 'January', slug: 'january', kind: 'campaign', scope: 'one', primary_location_id: STILL, offer_type: 'one_class' }

let db
beforeEach(() => {
  vi.clearAllMocks()
  db = fakeDb()
  createServerClient.mockReturnValue(db)
})

describe('GET /api/landing-pages', () => {
  it('401 without a session', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await GET(list())).status).toBe(401)
  })

  it('GET lists only pages the caller can view: a Stillorgan manager sees stillorgan, 50plus, trial (read-only flag), not corp', async () => {
    getCurrentUser.mockResolvedValue(STILL_MANAGER)
    const res = await GET(list())
    expect(res.status).toBe(200)
    const { success, data } = await res.json()
    expect(success).toBe(true)
    const bySlug = Object.fromEntries(data.map((p) => [p.slug, p]))
    expect(Object.keys(bySlug).sort()).toEqual(['50plus', 'stillorgan', 'trial'])
    expect(bySlug.trial.can_edit).toBe(false)
    expect(bySlug['50plus'].can_edit).toBe(true)
    expect(bySlug.trial.offer_summary).toBe('Paid trial, per studio')
    expect(bySlug['50plus'].offer_summary).toBe('One free class: 50+')
    expect(bySlug.trial.studios).toEqual([
      { location_id: STILL, name: 'UN1T Stillorgan', enabled: true, ready: true, reason: 'ready' },
      { location_id: HATCH, name: 'UN1T Hatch Street', enabled: true, ready: true, reason: 'ready' },
    ])
    // The list never carries the blocks, the chrome or a location's settings.
    expect(bySlug.trial).not.toHaveProperty('blocks')
    expect(JSON.stringify(data)).not.toContain('writes_enabled')
  })

  it('an org admin sees every page of the organisation, a master every organisation', async () => {
    getCurrentUser.mockResolvedValue(ORG_ADMIN)
    const admin = await (await GET(list())).json()
    expect(admin.data.map((p) => p.slug).sort()).toEqual(['50plus', 'corp', 'hatch-street', 'stillorgan', 'trial'])
    expect(admin.data.every((p) => p.can_edit)).toBe(true)

    getCurrentUser.mockResolvedValue(MASTER)
    const master = await (await GET(list())).json()
    expect(master.data.map((p) => p.slug)).toContain('autos')
  })

  it('a readiness read that fails is a 503, never a wrong chip', async () => {
    getCurrentUser.mockResolvedValue(STILL_MANAGER)
    createServerClient.mockReturnValue(fakeDb({ failures: { 'un1t_products.select': { message: 'boom' } } }))
    expect((await GET(list())).status).toBe(503)
  })
})

describe('POST /api/landing-pages', () => {
  it('POST refuses a reserved slug (400 reserved), a taken slug (409 taken), an all-studios page from a non-admin (403)', async () => {
    getCurrentUser.mockResolvedValue(STILL_MANAGER)
    const reserved = await POST(create({ ...NEW_ONE, slug: 'settings' }))
    expect(reserved.status).toBe(400)
    expect(await reserved.json()).toMatchObject({ success: false, error: 'reserved' })

    const invalid = await POST(create({ ...NEW_ONE, slug: 'Not A Slug' }))
    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toMatchObject({ error: 'invalid' })

    const taken = await POST(create({ ...NEW_ONE, slug: '50plus' }))
    expect(taken.status).toBe(409)
    expect(await taken.json()).toMatchObject({ success: false, error: 'taken' })

    const all = await POST(create({ ...NEW_ONE, scope: 'all', primary_location_id: null }))
    expect(all.status).toBe(403)
    expect(db.writes('landing_pages').filter((w) => w.op === 'insert')).toHaveLength(1) // the taken one only
  })

  it('a one-studio page needs landing_page at that studio (403) and a studio (400)', async () => {
    getCurrentUser.mockResolvedValue(STILL_MANAGER)
    expect((await POST(create({ ...NEW_ONE, primary_location_id: HATCH }))).status).toBe(403)
    const missing = await POST(create({ ...NEW_ONE, primary_location_id: null }))
    expect(missing.status).toBe(400)
    expect(await missing.json()).toMatchObject({ error: 'primary_location_required' })
    expect(db.writes('landing_pages')).toEqual([])
  })

  it('POST creates a draft with one studio row per active studio and copies only content blocks from start_from_page_id', async () => {
    getCurrentUser.mockResolvedValue(ORG_ADMIN)
    const res = await POST(create({ title: 'Spring', slug: 'spring', kind: 'campaign', scope: 'all', offer_type: 'paid_trial', start_from_page_id: PAGE.trial }))
    expect(res.status).toBe(201)
    const { data } = await res.json()
    expect(data).toMatchObject({ slug: 'spring', publish_state: 'draft', scope: 'all', primary_location_id: null, organization_id: ORG, chrome: { noindex: true, tone: 'dark' } })
    expect(resolveOrgChrome).toHaveBeenCalledWith(expect.objectContaining({ orgId: ORG }))

    const [offer, ...content] = data.blocks
    expect(offer.type).toBe('paid_trial')
    // The page half only: no studio key and no attribution key.
    for (const key of ['membership_id', 'plan_code', 'un1t_product_id', 'price_cents', 'tag', 'lead_source']) expect(offer).not.toHaveProperty(key)
    expect(content.map((b) => b.type)).toEqual(['stats', 'reviews'])
    expect(content.map((b) => b.id)).not.toContain('st')
    expect(content[0].items).toEqual([{ number: '1' }])

    const rows = db.state.landing_page_studios.filter((r) => r.page_id === data.id)
    expect(rows.map((r) => r.location_id)).toEqual([HATCH, STILL]) // by studio name; the inactive studio has none
    expect(rows.map((r) => r.location_id)).not.toContain(CLOSED)
    expect(rows.every((r) => r.enabled === false)).toBe(true)
    expect(rows.find((r) => r.location_id === STILL).attribution).toEqual({ tag: 'stillorgan-spring', lead_source: 'meta_spring' })
    expect(db.state.landing_pages.find((p) => p.id === data.id)).toMatchObject({ created_by: ORG_ADMIN.id, updated_by: ORG_ADMIN.id })
  })

  it('a one-studio page switches on its primary only and is branded by that studio', async () => {
    getCurrentUser.mockResolvedValue(STILL_MANAGER)
    const res = await POST(create(NEW_ONE))
    expect(res.status).toBe(201)
    const { data } = await res.json()
    expect(data.blocks).toHaveLength(1)
    expect(data.blocks[0].type).toBe('campaign_funnel')
    expect(data.blocks[0]).not.toHaveProperty('class_keywords')
    expect(data.blocks[0]).not.toHaveProperty('campaign')
    expect(resolveLocationBrand).toHaveBeenCalledWith(expect.objectContaining({ locationId: STILL }))
    const rows = db.state.landing_page_studios.filter((r) => r.page_id === data.id)
    expect(Object.fromEntries(rows.map((r) => [r.location_id, r.enabled]))).toEqual({ [STILL]: true, [HATCH]: false })
  })

  it('a one-studio page at an inactive studio is a 404', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    const res = await POST(create({ ...NEW_ONE, primary_location_id: CLOSED }))
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ success: false, error: 'not_found' })
    expect(db.writes('landing_pages')).toEqual([])
  })

  it('no offer starts with a hero; a start page the caller cannot view is a 404', async () => {
    getCurrentUser.mockResolvedValue(STILL_MANAGER)
    const res = await POST(create({ ...NEW_ONE, offer_type: 'none' }))
    expect((await res.json()).data.blocks.map((b) => b.type)).toEqual(['hero'])

    const hidden = await POST(create({ ...NEW_ONE, slug: 'copy', start_from_page_id: PAGE.corp }))
    expect(hidden.status).toBe(404)
    expect(await hidden.json()).toEqual({ success: false, error: 'not_found' })
  })

  it('a failed studio-row insert removes the page again and answers 500', async () => {
    getCurrentUser.mockResolvedValue(STILL_MANAGER)
    db = fakeDb({ failures: { 'landing_page_studios.insert': { message: 'boom' } } })
    createServerClient.mockReturnValue(db)
    expect((await POST(create(NEW_ONE))).status).toBe(500)
    expect(db.state.landing_pages.find((p) => p.slug === 'january')).toBeUndefined()
  })
})
