// PAGES.1 — GET / PUT /api/landing-pages/[id]: one page with its studio rows,
// and its save (title, slug, blocks, chrome). A page outside the caller's view
// is a 404; a page they may view but not edit is a 403 on PUT.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))

const { createServerClient } = await import('@/lib/supabase')
const { getCurrentUser } = await import('@/lib/auth')
const { logError } = await import('@/lib/log')
const { GET, PUT } = await import('./route.js')
const { fakeDb, STILL_MANAGER, ORG_ADMIN, PAGE, STILL, jsonRequest } = await import('../../../../../tests/helpers/landing-pages-fixtures.js')

const ctx = (id) => ({ params: Promise.resolve({ id }) })
const put = (id, body) => PUT(jsonRequest(`/api/landing-pages/${id}`, 'PUT', body), ctx(id))
const get = (id) => GET(new Request(`http://localhost/api/landing-pages/${id}`), ctx(id))
const stored = (db, id) => db.state.landing_pages.find((p) => p.id === id)

let db
beforeEach(() => {
  vi.clearAllMocks()
  db = fakeDb()
  createServerClient.mockReturnValue(db)
})

describe('GET /api/landing-pages/[id]', () => {
  it('answers the page, its studio rows (never the location settings) and can_edit', async () => {
    getCurrentUser.mockResolvedValue(STILL_MANAGER)
    const res = await get(PAGE.trial)
    expect(res.status).toBe(200)
    const { data } = await res.json()
    expect(data.page.slug).toBe('trial')
    expect(data.can_edit).toBe(false)
    expect(data.studios.map((s) => [s.location_id, s.readiness.reason])).toEqual([[STILL, 'ready'], [expect.any(String), 'ready']])
    // Each row carries its studio's public path (the editor's default tag).
    expect(data.studios.map((s) => s.public_path)).toEqual(['stillorgan', 'hatch-street'])
    expect(JSON.stringify(data)).not.toContain('settings')
  })

  it('a read-only viewer gets no studio half; an editor does', async () => {
    getCurrentUser.mockResolvedValue(STILL_MANAGER)
    const viewer = (await (await get(PAGE.trial)).json()).data
    expect(viewer.studios).toHaveLength(2)
    for (const row of viewer.studios) {
      expect(row).not.toHaveProperty('offer')
      expect(row).not.toHaveProperty('attribution')
      expect(row).toMatchObject({ enabled: true, readiness: { ready: true } })
    }
    expect(JSON.stringify(viewer)).not.toContain('plan_code')

    getCurrentUser.mockResolvedValue(ORG_ADMIN)
    const editor = (await (await get(PAGE.trial)).json()).data
    expect(editor.studios[0].offer).toMatchObject({ plan_code: 'p' })
  })

  it('404 for a page outside the caller\'s view, an unknown id and a non-uuid', async () => {
    getCurrentUser.mockResolvedValue(STILL_MANAGER)
    for (const id of [PAGE.corp, PAGE.other, 'd0000000-0000-0000-0000-00000000ffff', 'nope']) {
      const res = await get(id)
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({ success: false, error: 'not_found' })
    }
  })

  it('401 without a session', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await get(PAGE.trial)).status).toBe(401)
  })
})

describe('PUT /api/landing-pages/[id]', () => {
  const trialBlocks = [{ id: 'pt', type: 'paid_trial', heading: 'New words' }, { id: 'st', type: 'stats' }]

  it('PUT by a studio manager on an all-studios page is 403; by an org admin saves blocks and chrome', async () => {
    getCurrentUser.mockResolvedValue(STILL_MANAGER)
    expect((await put(PAGE.trial, { blocks: trialBlocks })).status).toBe(403)
    expect(db.writes('landing_pages')).toEqual([])

    getCurrentUser.mockResolvedValue(ORG_ADMIN)
    const res = await put(PAGE.trial, {
      title: '14 Day Reset',
      blocks: [{ ...trialBlocks[0], membership_id: 'sneaky', tag: 'x' }, trialBlocks[1]],
      chrome: { meta_title: 'The Reset', un1t_terms: { terms_label: 'I agree' }, was_live: false },
    })
    expect(res.status).toBe(200)
    const row = stored(db, PAGE.trial)
    expect(row.blocks).toEqual(trialBlocks) // the studio half is stripped, never stored
    expect(row.chrome).toEqual({ meta_title: 'The Reset', un1t_terms: { terms_label: 'I agree' } })
    expect(row.updated_by).toBe(ORG_ADMIN.id)
  })

  it('refuses a blocks array whose first block is not the offer block, and any non-updatable field', async () => {
    getCurrentUser.mockResolvedValue(ORG_ADMIN)
    const res = await put(PAGE.trial, { blocks: [trialBlocks[1], trialBlocks[0]] })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'offer_block_required' })
    expect((await put(PAGE.trial, { offer_type: 'none' })).status).toBe(400)
    expect((await put(PAGE.trial, { chrome: { colour: 'red' } })).status).toBe(400)
    expect(db.writes('landing_pages')).toEqual([])
  })

  it('a studio page keeps its offer block where mig 792 put it', async () => {
    getCurrentUser.mockResolvedValue(STILL_MANAGER)
    const blocks = [{ id: 'h1', type: 'hero' }, { id: 'pt1', type: 'paid_trial', heading: 'Try us', plan_code: 'x' }]
    expect((await put(PAGE.stillorgan, { blocks })).status).toBe(200)
    expect(stored(db, PAGE.stillorgan).blocks[1]).toEqual({ id: 'pt1', type: 'paid_trial', heading: 'Try us' })
    expect((await put(PAGE.stillorgan, { blocks: [{ id: 'h1', type: 'hero' }] })).status).toBe(400)
  })

  it('PUT renaming a page that was live writes a retired redirect row for the old slug', async () => {
    getCurrentUser.mockResolvedValue(STILL_MANAGER)
    const res = await put(PAGE.fiftyplus, { slug: 'fifty-plus' })
    expect(res.status).toBe(200)
    expect((await res.json()).data.slug).toBe('fifty-plus')
    const retired = db.state.landing_pages.find((p) => p.slug === '50plus')
    expect(retired).toMatchObject({
      kind: 'campaign', scope: 'one', primary_location_id: STILL, offer_type: 'none', publish_state: 'retired',
      redirect_to: '/fifty-plus', blocks: [], chrome: { noindex: true }, title: 'The 50+ Club (moved)',
    })
  })

  it('a draft that was never live renames without a redirect; slug problems are 400 / 409', async () => {
    getCurrentUser.mockResolvedValue(STILL_MANAGER)
    stored(db, PAGE.fiftyplus).publish_state = 'draft'
    expect((await put(PAGE.fiftyplus, { slug: 'fifty' })).status).toBe(200)
    expect(db.state.landing_pages.find((p) => p.slug === '50plus')).toBeUndefined()

    expect(await (await put(PAGE.fiftyplus, { slug: 'admin' })).json()).toMatchObject({ error: 'reserved' })
    const taken = await put(PAGE.fiftyplus, { slug: 'stillorgan' })
    expect(taken.status).toBe(409)
    expect(await taken.json()).toMatchObject({ error: 'taken' })
  })

  it('a failed retired-row insert after the rename keeps the rename and answers 500', async () => {
    getCurrentUser.mockResolvedValue(STILL_MANAGER)
    db = fakeDb({ failures: { 'landing_pages.insert': { message: 'boom', code: 'XX000' } } })
    createServerClient.mockReturnValue(db)
    const res = await put(PAGE.fiftyplus, { slug: 'fifty-plus' })
    expect(res.status).toBe(500)
    expect(stored(db, PAGE.fiftyplus).slug).toBe('fifty-plus')
    expect(logError).toHaveBeenCalled()
  })

  it('a studio page keeps its slug: it is the studio\'s public path', async () => {
    getCurrentUser.mockResolvedValue(STILL_MANAGER)
    const res = await put(PAGE.stillorgan, { slug: 'stillorgan-2' })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'studio_page' })
  })
})
