// PAGES.1 (Task 18a) — POST /api/landing-page-settings/media with page_id:
// an upload is attributed to the PAGE (pages/<page_id>/…), gated on
// canEditPage; location_id stays the studio-level alternative.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))

const { createServerClient } = await import('@/lib/supabase')
const { getCurrentUser } = await import('@/lib/auth')
const { logError } = await import('@/lib/log')
const { POST } = await import('./route.js')
const { fakeDb, STILL_MANAGER, ORG_ADMIN, PAGE, STILL, HATCH } = await import('../../../../../tests/helpers/landing-pages-fixtures.js')

let db, uploads
beforeEach(() => {
  vi.clearAllMocks()
  const base = fakeDb()
  uploads = []
  db = {
    ...base,
    from: base.from,
    storage: {
      from: (bucket) => ({
        upload: async (path, _buf, opts) => { uploads.push({ bucket, path, opts }); return { error: null } },
        getPublicUrl: (path) => ({ data: { publicUrl: `https://cdn.test/${bucket}/${path}` } }),
      }),
    },
  }
  createServerClient.mockReturnValue(db)
})

const upload = (fields) => {
  const form = new FormData()
  form.set('file', new File([new Uint8Array([1, 2, 3])], 'a.png', { type: 'image/png' }))
  for (const [k, v] of Object.entries(fields)) form.set(k, v)
  return POST(new Request('http://localhost/api/landing-page-settings/media', { method: 'POST', body: form }))
}

describe('POST /api/landing-page-settings/media with page_id', () => {
  it('page_id upload lands under pages/<id>/ and needs canEditPage', async () => {
    getCurrentUser.mockResolvedValue(ORG_ADMIN)
    const res = await upload({ page_id: PAGE.trial, kind: 'image' })
    expect(res.status).toBe(200)
    expect(uploads).toHaveLength(1)
    expect(uploads[0].bucket).toBe('branding')
    expect(uploads[0].path).toMatch(new RegExp(`^pages/${PAGE.trial}/[0-9a-f-]{36}\\.png$`))
    const body = await res.json()
    expect(body).toEqual({ success: true, url: `https://cdn.test/branding/${uploads[0].path}` })
  })

  it('page_id wins when location_id is also given (location_id is ignored)', async () => {
    getCurrentUser.mockResolvedValue(ORG_ADMIN)
    const res = await upload({ page_id: PAGE.trial, location_id: 'not-even-a-uuid', kind: 'image' })
    expect(res.status).toBe(200)
    expect(uploads[0].path.startsWith(`pages/${PAGE.trial}/`)).toBe(true)
  })

  it('a caller who can view but not edit the page is 403', async () => {
    getCurrentUser.mockResolvedValue(STILL_MANAGER)
    const res = await upload({ page_id: PAGE.trial, kind: 'image' })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ success: false, error: 'You can view this page but not edit it' })
    expect(uploads).toEqual([])
  })

  it('an unknown page, and a page outside the caller\'s view, are 404', async () => {
    getCurrentUser.mockResolvedValue(STILL_MANAGER)
    for (const id of ['d0000000-0000-0000-0000-00000000ffff', PAGE.other, PAGE.corp]) {
      const res = await upload({ page_id: id, kind: 'image' })
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({ success: false, error: 'not_found' })
    }
    expect(uploads).toEqual([])
  })

  it('401 without a session', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await upload({ page_id: PAGE.trial, kind: 'image' })).status).toBe(401)
    expect(uploads).toEqual([])
  })

  it('an unreadable page is 503 and is logged', async () => {
    getCurrentUser.mockResolvedValue(ORG_ADMIN)
    db = { ...db, from: fakeDb({ failures: { 'landing_pages.select': { code: 'XX000', message: 'boom' } } }).from }
    createServerClient.mockReturnValue(db)
    const res = await upload({ page_id: PAGE.trial, kind: 'image' })
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ success: false, error: 'unavailable' })
    expect(logError).toHaveBeenCalled()
    expect(uploads).toEqual([])
  })

  it('the kind and size rules are unchanged on the page branch', async () => {
    getCurrentUser.mockResolvedValue(ORG_ADMIN)
    const form = new FormData()
    form.set('file', new File([new Uint8Array([1])], 'a.gif', { type: 'image/gif' }))
    form.set('page_id', PAGE.trial)
    const res = await POST(new Request('http://localhost/x', { method: 'POST', body: form }))
    expect(res.status).toBe(400)
    expect(uploads).toEqual([])
  })
})

describe('POST /api/landing-page-settings/media identity', () => {
  it('neither id is 400', async () => {
    getCurrentUser.mockResolvedValue(ORG_ADMIN)
    const res = await upload({ kind: 'image' })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ success: false, error: 'page_id or location_id is required' })
    expect(uploads).toEqual([])
  })

  it('location_id branch unchanged: a member with the permission uploads under landing-page/<location>/', async () => {
    getCurrentUser.mockResolvedValue(STILL_MANAGER)
    const res = await upload({ location_id: STILL, kind: 'image' })
    expect(res.status).toBe(200)
    expect(uploads[0].path).toMatch(new RegExp(`^landing-page/${STILL}/[0-9a-f-]{36}\\.png$`))
  })

  it('location_id branch unchanged: a non-member is refused as before', async () => {
    getCurrentUser.mockResolvedValue(STILL_MANAGER)
    const res = await upload({ location_id: HATCH, kind: 'image' })
    expect(res.status).toBe(403)
    expect(uploads).toEqual([])
  })
})
