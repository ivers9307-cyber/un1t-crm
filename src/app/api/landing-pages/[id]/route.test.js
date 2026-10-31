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
const { fakeDb, STILL_MANAGER, STILL_COACH, ORG_ADMIN, PAGE, STILL, HATCH, jsonRequest } = await import('../../../../../tests/helpers/landing-pages-fixtures.js')

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

  it('a coach without landing_page gets a 404 even at their own studio', async () => {
    getCurrentUser.mockResolvedValue(STILL_COACH)
    for (const id of [PAGE.trial, PAGE.fiftyplus, PAGE.stillorgan]) expect((await get(id)).status).toBe(404)
  })

  it('a non-editor gets the blocks through clientSafeBlocks; an editor as stored', async () => {
    db.state.landing_pages.find((p) => p.id === PAGE.trial).blocks = [
      { id: 'pt', type: 'paid_trial', heading: 'The Reset' },
      { id: 'lf', type: 'lead_form', heading: 'Join', tag: 'operator-tag', lead_source: 'operator-source' },
    ]
    getCurrentUser.mockResolvedValue(STILL_MANAGER)
    const viewer = (await (await get(PAGE.trial)).json()).data
    expect(viewer.page.blocks[1]).toEqual({ id: 'lf', type: 'lead_form', heading: 'Join' })
    getCurrentUser.mockResolvedValue(ORG_ADMIN)
    const editor = (await (await get(PAGE.trial)).json()).data
    expect(editor.page.blocks[1]).toMatchObject({ tag: 'operator-tag', lead_source: 'operator-source' })
  })

  it('a one-studio page answers its primary\'s row only', async () => {
    db.state.landing_page_studios.push({ page_id: PAGE.fiftyplus, location_id: HATCH, enabled: true, offer: {}, attribution: {}, sort_order: 1 })
    getCurrentUser.mockResolvedValue(STILL_MANAGER)
    const { data } = await (await get(PAGE.fiftyplus)).json()
    expect(data.studios.map((s) => s.location_id)).toEqual([STILL])
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

  it('a studio page\'s blocks and chrome save; its slug does not', async () => {
    getCurrentUser.mockResolvedValue(STILL_MANAGER)
    // mig 792 kept the studio's own order: the offer block need not be first.
    const blocks = [{ id: 'h1', type: 'hero', headline: 'Strong' }, { id: 'pt1', type: 'paid_trial', heading: 'Try us', plan_code: 'leak' }]
    const res = await put(PAGE.stillorgan, {
      title: 'UN1T Stillorgan',
      slug: 'stillorgan', // the stored slug: not a rename
      blocks,
      chrome: { un1t_terms: { terms_label: 'I agree', waiver_link_label: null } },
    })
    expect(res.status).toBe(200)
    const row = stored(db, PAGE.stillorgan)
    expect(row.blocks).toEqual([blocks[0], { id: 'pt1', type: 'paid_trial', heading: 'Try us' }])
    expect(row.chrome).toEqual({ un1t_terms: { terms_label: 'I agree', waiver_link_label: null } })
    expect(row.slug).toBe('stillorgan')

    // Without its offer block a studio page with an offer is refused.
    const missing = await put(PAGE.stillorgan, { blocks: [blocks[0]] })
    expect(missing.status).toBe(400)
    expect(await missing.json()).toMatchObject({ error: 'offer_block_required' })

    // The slug is the studio's public path: a rename is refused before any write.
    const before = db.writes('landing_pages').length
    const renamed = await put(PAGE.stillorgan, { slug: 'stillorgan-2', title: 'Changed' })
    expect(renamed.status).toBe(400)
    expect(await renamed.json()).toMatchObject({ error: 'studio_page' })
    expect(db.writes('landing_pages')).toHaveLength(before)
    expect(stored(db, PAGE.stillorgan)).toMatchObject({ slug: 'stillorgan', title: 'UN1T Stillorgan' })
  })

  it('a studio page reports can_edit to its studio\'s editor, with its row\'s offer', async () => {
    getCurrentUser.mockResolvedValue(STILL_MANAGER)
    const { data } = await (await get(PAGE.stillorgan)).json()
    expect(data.can_edit).toBe(true)
    expect(data.studios[0].offer).toMatchObject({ plan_code: 'p' })
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

  it('the reserved settings, api and contacts refuse a rename with nothing written (Review Focus 2)', async () => {
    getCurrentUser.mockResolvedValue(STILL_MANAGER)
    for (const slug of ['settings', 'api', 'contacts']) {
      const res = await put(PAGE.fiftyplus, { slug, title: 'Changed' })
      expect(res.status).toBe(400)
      expect(await res.json()).toMatchObject({ success: false, error: 'reserved' })
    }
    expect(db.writes('landing_pages')).toEqual([])
    expect(stored(db, PAGE.fiftyplus)).toMatchObject({ slug: '50plus', title: 'The 50+ Club' })
  })

  it('a failed retired-row insert undoes the rename (slug and the rest of the save) and answers 500', async () => {
    getCurrentUser.mockResolvedValue(STILL_MANAGER)
    db = fakeDb({ failures: { 'landing_pages.insert': { message: 'boom', code: 'XX000' } } })
    createServerClient.mockReturnValue(db)
    const res = await put(PAGE.fiftyplus, { slug: 'fifty-plus', title: 'Fifty plus' })
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ success: false, error: 'The page could not be renamed' })
    expect(stored(db, PAGE.fiftyplus)).toMatchObject({ slug: '50plus', title: 'The 50+ Club' })
    expect(db.state.landing_pages.filter((p) => p.slug === '50plus')).toHaveLength(1)
    expect(logError).toHaveBeenCalledWith('landing-pages', expect.stringContaining('rename undone'), expect.objectContaining({ code: 'XX000' }))
  })

  it('when the undo fails too, the rename is kept and answered 500 with the renamed page; both failures logged', async () => {
    getCurrentUser.mockResolvedValue(STILL_MANAGER)
    db = fakeDb({
      failures: {
        'landing_pages.insert': { message: 'boom', code: 'XX000' },
        // The undo is the update that writes the old slug back.
        'landing_pages.update': (q) => (q.payload.slug === '50plus' ? { message: 'down', code: 'XX001' } : null),
      },
    })
    createServerClient.mockReturnValue(db)
    const res = await put(PAGE.fiftyplus, { slug: 'fifty-plus' })
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body).toMatchObject({ success: false, error: 'The page was renamed, but its old address could not be redirected' })
    expect(body.data.slug).toBe('fifty-plus')
    expect(stored(db, PAGE.fiftyplus).slug).toBe('fifty-plus')
    expect(logError).toHaveBeenCalledWith('landing-pages', 'page renamed but the old slug has no redirect', expect.objectContaining({ code: 'XX000' }))
    expect(logError).toHaveBeenCalledWith('landing-pages', 'rename could not be undone', expect.objectContaining({ code: 'XX001' }))
  })

})
