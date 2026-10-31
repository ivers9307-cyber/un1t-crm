// PAGES.1 (Task 18a) — POST /api/landing-page-settings/media/signed-upload
// with page_id: the signed path is pages/<page_id>/…, gated on canEditPage;
// location_id stays the studio-level alternative.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))

const { createServerClient } = await import('@/lib/supabase')
const { getCurrentUser } = await import('@/lib/auth')
const { logError } = await import('@/lib/log')
const { POST } = await import('./route.js')
const { fakeDb, STILL_MANAGER, ORG_ADMIN, PAGE, STILL, HATCH, jsonRequest } = await import('../../../../../../tests/helpers/landing-pages-fixtures.js')

let db, signed
beforeEach(() => {
  vi.clearAllMocks()
  const base = fakeDb()
  signed = []
  db = {
    ...base,
    from: base.from,
    storage: {
      from: (bucket) => ({
        createSignedUploadUrl: async (path) => { signed.push({ bucket, path }); return { data: { path, token: 'tok' }, error: null } },
        getPublicUrl: (path) => ({ data: { publicUrl: `https://cdn.test/${bucket}/${path}` } }),
      }),
    },
  }
  createServerClient.mockReturnValue(db)
})

const sign = (body) => POST(jsonRequest('/api/landing-page-settings/media/signed-upload', 'POST', { kind: 'video', content_type: 'video/mp4', ...body }))

describe('POST …/media/signed-upload with page_id', () => {
  it('page_id upload signs a path under pages/<id>/ and needs canEditPage', async () => {
    getCurrentUser.mockResolvedValue(ORG_ADMIN)
    const res = await sign({ page_id: PAGE.trial })
    expect(res.status).toBe(200)
    expect(signed).toHaveLength(1)
    expect(signed[0].bucket).toBe('branding')
    expect(signed[0].path).toMatch(new RegExp(`^pages/${PAGE.trial}/[0-9a-f-]{36}\\.mp4$`))
    expect(await res.json()).toEqual({
      success: true, path: signed[0].path, token: 'tok', url: `https://cdn.test/branding/${signed[0].path}`,
    })
  })

  it('page_id wins when location_id is also given', async () => {
    getCurrentUser.mockResolvedValue(ORG_ADMIN)
    const res = await sign({ page_id: PAGE.trial, location_id: HATCH })
    expect(res.status).toBe(200)
    expect(signed[0].path.startsWith(`pages/${PAGE.trial}/`)).toBe(true)
  })

  it('a caller who can view but not edit the page is 403', async () => {
    getCurrentUser.mockResolvedValue(STILL_MANAGER)
    const res = await sign({ page_id: PAGE.trial })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ success: false, error: 'You can view this page but not edit it' })
    expect(signed).toEqual([])
  })

  it('an unknown page, and a page outside the caller\'s view, are 404', async () => {
    getCurrentUser.mockResolvedValue(STILL_MANAGER)
    for (const id of ['d0000000-0000-0000-0000-00000000ffff', PAGE.other, PAGE.corp]) {
      const res = await sign({ page_id: id })
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({ success: false, error: 'not_found' })
    }
    expect(signed).toEqual([])
  })

  it('401 without a session', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await sign({ page_id: PAGE.trial })).status).toBe(401)
    expect(signed).toEqual([])
  })

  it('an unreadable page is 503 and is logged', async () => {
    getCurrentUser.mockResolvedValue(ORG_ADMIN)
    db = { ...db, from: fakeDb({ failures: { 'landing_pages.select': { code: 'XX000', message: 'boom' } } }).from }
    createServerClient.mockReturnValue(db)
    const res = await sign({ page_id: PAGE.trial })
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ success: false, error: 'unavailable' })
    expect(logError).toHaveBeenCalled()
    expect(signed).toEqual([])
  })

  it('the type rules are unchanged on the page branch', async () => {
    getCurrentUser.mockResolvedValue(ORG_ADMIN)
    const res = await sign({ page_id: PAGE.trial, kind: 'image', content_type: 'image/gif' })
    expect(res.status).toBe(400)
    expect(signed).toEqual([])
  })
})

describe('POST …/media/signed-upload identity', () => {
  it('neither id is 400', async () => {
    getCurrentUser.mockResolvedValue(ORG_ADMIN)
    const res = await sign({})
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ success: false, error: 'page_id or location_id is required' })
    expect(signed).toEqual([])
  })

  it('location_id branch unchanged: a member with the permission signs landing-page/<location>/', async () => {
    getCurrentUser.mockResolvedValue(STILL_MANAGER)
    const res = await sign({ location_id: STILL })
    expect(res.status).toBe(200)
    expect(signed[0].path).toMatch(new RegExp(`^landing-page/${STILL}/[0-9a-f-]{36}\\.mp4$`))
  })

  it('location_id branch unchanged: a non-member is refused as before', async () => {
    getCurrentUser.mockResolvedValue(STILL_MANAGER)
    const res = await sign({ location_id: HATCH })
    expect(res.status).toBe(403)
    expect(signed).toEqual([])
  })
})
