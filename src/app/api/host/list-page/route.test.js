// HOST-GROWTH.7 — GET/PATCH /api/host/list-page: the host's own /h/[slug]
// signup-page copy (mig 460's four nullable list_* columns on event_hosts).
// PATCH updates only the session host's row; empty string → NULL (renders
// the built-in default copy on the public page).

import { describe, it, expect, vi, beforeEach } from 'vitest'

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
