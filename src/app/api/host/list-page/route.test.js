// HOST-GROWTH.7 — GET/PATCH /api/host/list-page: the host's own /h/[slug]
// signup-page copy (mig 460's four nullable list_* columns on event_hosts).
// PATCH updates only the session host's row; empty string → NULL (renders
// the built-in default copy on the public page).

import { describe, it, expect, vi, beforeEach } from 'vitest'

// The photo-URL check pins the project Supabase host (security review).
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://cdn.test'

const mocks = vi.hoisted(() => ({ getCurrentHost: vi.fn(), createServerClient: vi.fn() }))
vi.mock('@/lib/host-auth', () => ({ getCurrentHost: mocks.getCurrentHost }))
vi.mock('@/lib/supabase', () => ({ createServerClient: mocks.createServerClient }))

import { GET, PATCH } from './route'

function dbWith({ row = {}, updateError = null, selectError = null } = {}) {
  const update = vi.fn(() => ({ eq: vi.fn(async () => ({ error: updateError })) }))
  return {
    from: vi.fn(() => ({
      select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: vi.fn(async () => ({ data: row, error: selectError })) })) })),
      update,
    })),
    _update: update,
  }
}

function req(body) {
  return new Request('http://x/api/host/list-page', {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
}

beforeEach(() => vi.clearAllMocks())

describe('PATCH /api/host/list-page', () => {
  it('401s without a host session', async () => {
    mocks.getCurrentHost.mockResolvedValue(null)
    const res = await PATCH(req({ list_headline: 'Hi' }))
    expect(res.status).toBe(401)
  })

  it('rejects over-cap fields with issues', async () => {
    mocks.getCurrentHost.mockResolvedValue({ host: { id: 'h1' } })
    mocks.createServerClient.mockReturnValue(dbWith({}))
    const res = await PATCH(req({ list_headline: 'x'.repeat(121) }))
    expect(res.status).toBe(400)
    const j = await res.json()
    expect(j.issues?.length).toBeGreaterThan(0)
  })

  it('rejects unknown keys (strict schema)', async () => {
    mocks.getCurrentHost.mockResolvedValue({ host: { id: 'h1' } })
    mocks.createServerClient.mockReturnValue(dbWith({}))
    const res = await PATCH(req({ nope: 'x' }))
    expect(res.status).toBe(400)
  })

  it('400s an empty body (nothing to update)', async () => {
    mocks.getCurrentHost.mockResolvedValue({ host: { id: 'h1' } })
    mocks.createServerClient.mockReturnValue(dbWith({}))
    const res = await PATCH(req({}))
    expect(res.status).toBe(400)
  })

  it('trims, converts empty strings to null, and updates only the host row', async () => {
    mocks.getCurrentHost.mockResolvedValue({ host: { id: 'h1' } })
    const db = dbWith({})
    mocks.createServerClient.mockReturnValue(db)
    const res = await PATCH(req({ list_headline: '  Hello  ', list_blurb: '' }))
    expect(res.status).toBe(200)
    expect(db._update).toHaveBeenCalledWith({ list_headline: 'Hello', list_blurb: null })
  })

  it('500s with a generic message (not the raw db error) when the update fails', async () => {
    mocks.getCurrentHost.mockResolvedValue({ host: { id: 'h1' } })
    mocks.createServerClient.mockReturnValue(dbWith({ updateError: { message: 'boom' } }))
    const res = await PATCH(req({ list_headline: 'Hi' }))
    expect(res.status).toBe(500)
    const j = await res.json()
    expect(j.error).toBe('Could not save — try again shortly.')
    expect(j.error).not.toContain('boom')
  })
})

describe('GET /api/host/list-page', () => {
  it('401s without a host session', async () => {
    mocks.getCurrentHost.mockResolvedValue(null)
    const res = await GET()
    expect(res.status).toBe(401)
  })

  it('returns the four copy fields + slug for the session host', async () => {
    mocks.getCurrentHost.mockResolvedValue({ host: { id: 'h1' } })
    mocks.createServerClient.mockReturnValue(dbWith({ row: { slug: 'acme', list_headline: 'Hi', list_blurb: null, list_button_label: null, list_success_message: null } }))
    const res = await GET()
    const j = await res.json()
    expect(j.success).toBe(true)
    expect(j.data.list_headline).toBe('Hi')
    expect(j.data.slug).toBe('acme')
  })

  it('500s with a generic message (not the raw db error) when the load fails', async () => {
    mocks.getCurrentHost.mockResolvedValue({ host: { id: 'h1' } })
    mocks.createServerClient.mockReturnValue(dbWith({ selectError: { message: 'boom' } }))
    const res = await GET()
    expect(res.status).toBe(500)
    const j = await res.json()
    expect(j.error).toBe('Could not load your signup page settings.')
    expect(j.error).not.toContain('boom')
  })
})

describe('PATCH /api/host/list-page — branding (HOST-EVENTS-PAGE.1)', () => {
  it('rejects a malformed accent and a non-http hero', async () => {
    mocks.getCurrentHost.mockResolvedValue({ host: { id: 'h1' } })
    mocks.createServerClient.mockReturnValue(dbWith({}))
    expect((await PATCH(req({ accent_hex: 'red' }))).status).toBe(400)
    expect((await PATCH(req({ hero_image_url: 'javascript:alert(1)' }))).status).toBe(400)
  })
  it('writes a valid accent + hero and clears them on empty string', async () => {
    mocks.getCurrentHost.mockResolvedValue({ host: { id: 'h1' } })
    const db = dbWith({})
    mocks.createServerClient.mockReturnValue(db)
    const res = await PATCH(req({ accent_hex: '#FF5A1F', hero_image_url: 'https://cdn.example/hero.png', events_headline: 'Train with PTC', events_blurb: '' }))
    expect(res.status).toBe(200)
    expect(db._update).toHaveBeenCalledWith({ accent_hex: '#FF5A1F', hero_image_url: 'https://cdn.example/hero.png', events_headline: 'Train with PTC', events_blurb: null })
  })
})

// HOSTPAGE.2 — the page extras ride the same PATCH.
describe('PATCH /api/host/list-page — page extras (HOSTPAGE.2)', () => {
  it('writes about, photos, testimonials and the toggles as given', async () => {
    mocks.getCurrentHost.mockResolvedValue({ host: { id: 'h1' } })
    const db = dbWith()
    mocks.createServerClient.mockReturnValue(db)
    // A URL under the host's own bucket folder (the upload route's shape); any other is refused below.
    const photos = [{ url: 'https://cdn.test/storage/v1/object/public/branding/host-photos/h1/a.jpg', caption: ' Warm up ' }]
    const testimonials = [{ quote: ' Brilliant class ', author: 'Aoife' }]
    const res = await PATCH(req({ about_text: '  Who we are. ', photos, testimonials, show_ratings: false, show_past_events: true }))
    expect(res.status).toBe(200)
    expect(db._update).toHaveBeenCalledWith({
      about_text: 'Who we are.',
      photos: [{ url: 'https://cdn.test/storage/v1/object/public/branding/host-photos/h1/a.jpg', caption: 'Warm up' }],
      testimonials: [{ quote: 'Brilliant class', author: 'Aoife' }],
      show_ratings: false,
      show_past_events: true,
    })
  })
  it('refuses a 401-char quote and a thirteenth photo', async () => {
    mocks.getCurrentHost.mockResolvedValue({ host: { id: 'h1' } })
    mocks.createServerClient.mockReturnValue(dbWith())
    expect((await PATCH(req({ testimonials: [{ quote: 'x'.repeat(401) }] }))).status).toBe(400)
    expect((await PATCH(req({ photos: Array.from({ length: 13 }, () => ({ url: 'https://cdn.test/p.jpg' })) }))).status).toBe(400)
  })
  it('GET returns the extras too', async () => {
    mocks.getCurrentHost.mockResolvedValue({ host: { id: 'h1' } })
    const row = { slug: 'acme', about_text: 'Hi', photos: [], testimonials: [], show_past_events: true, show_ratings: true }
    mocks.createServerClient.mockReturnValue(dbWith({ row }))
    const res = await GET()
    expect((await res.json()).data).toEqual(row)
  })
})

describe('PATCH /api/host/list-page — photo URLs (HOSTPAGE.2 review)', () => {
  const OWN = 'https://cdn.test/storage/v1/object/public/branding/host-photos/h1/a.jpg'
  const OWN2 = 'https://cdn.test/storage/v1/object/public/branding/host-photos/h1/b.jpg'
  it('may caption or reorder stored photos and add a URL under the host\'s own folder, but never introduce any other URL', async () => {
    mocks.getCurrentHost.mockResolvedValue({ host: { id: 'h1' } })
    let db = dbWith({ row: { photos: [{ url: OWN, caption: null }] } })
    mocks.createServerClient.mockReturnValue(db)
    expect((await PATCH(req({ photos: [{ url: OWN, caption: 'Warm up' }, { url: OWN2, caption: null }] }))).status).toBe(200)
    expect(db._update).toHaveBeenCalledWith({ photos: [{ url: OWN, caption: 'Warm up' }, { url: OWN2, caption: null }] })
    for (const bad of ['https://evil.example/pixel.gif', 'data:image/png;base64,AAAA', 'javascript:alert(1)', 'https://cdn.test/storage/v1/object/public/branding/host-photos/h2/x.jpg']) {
      db = dbWith({ row: { photos: [{ url: OWN, caption: null }] } })
      mocks.createServerClient.mockReturnValue(db)
      const res = await PATCH(req({ photos: [{ url: OWN, caption: null }, { url: bad, caption: null }] }))
      expect(res.status, bad).toBe(400)
      expect(db._update, bad).not.toHaveBeenCalled()
    }
  })
})
