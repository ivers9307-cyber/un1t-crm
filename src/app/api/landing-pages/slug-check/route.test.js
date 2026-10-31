// PAGES.1 — GET /api/landing-pages/slug-check?slug=[&location_id=]: whether a
// path is free in the organisation the page would be created in (the chosen
// studio's, else the caller's active one): the New page form's pre-check.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))

const { createServerClient } = await import('@/lib/supabase')
const { getCurrentUser } = await import('@/lib/auth')
const { GET } = await import('./route.js')
const { fakeDb, STILL_MANAGER, MASTER, ORG, OTHER_ORG, STILL, HATCH, ELSEWHERE } = await import('../../../../../tests/helpers/landing-pages-fixtures.js')

const check = async (slug) => {
  const res = await GET(new Request(`http://localhost/api/landing-pages/slug-check?slug=${encodeURIComponent(slug)}&org=${OTHER_ORG}`))
  return { status: res.status, body: await res.json() }
}

let db
beforeEach(() => {
  vi.clearAllMocks()
  db = fakeDb()
  createServerClient.mockReturnValue(db)
  getCurrentUser.mockResolvedValue(STILL_MANAGER)
})

describe('GET /api/landing-pages/slug-check', () => {
  it('answers available/problem for the caller org', async () => {
    expect(await check('january')).toEqual({ status: 200, body: { success: true, data: { available: true, problem: null } } })
    expect((await check('50plus')).body.data).toEqual({ available: false, problem: 'taken' })
    expect((await check('settings')).body.data).toEqual({ available: false, problem: 'reserved' })
    expect((await check('No Way')).body.data).toEqual({ available: false, problem: 'invalid' })
    // Another organisation's slug is free here; ?org= is never honoured.
    expect((await check('autos')).body.data).toEqual({ available: true, problem: null })
    const reads = db.calls.filter((c) => c.table === 'landing_pages')
    expect(reads.every((c) => c.eqs.some(([col, v]) => col === 'organization_id' && v === ORG))).toBe(true)
  })

  it('with location_id, judges that studio\'s organisation (a master on another tenant\'s studio)', async () => {
    getCurrentUser.mockResolvedValue(MASTER)
    const at = async (slug, loc) => {
      const res = await GET(new Request(`http://localhost/api/landing-pages/slug-check?slug=${slug}&location_id=${loc}`))
      return { status: res.status, body: await res.json() }
    }
    // MASTER's active organisation is UN1T, but the chosen studio is CCF Autos'.
    expect((await at('autos', ELSEWHERE)).body.data).toEqual({ available: false, problem: 'taken' })
    expect((await at('50plus', ELSEWHERE)).body.data).toEqual({ available: true, problem: null })
    expect((await at('50plus', STILL)).body.data).toEqual({ available: false, problem: 'taken' })
    const unknown = await at('january', 'a0000000-0000-0000-0000-0000000000ff')
    expect(unknown).toEqual({ status: 404, body: { success: false, error: 'not_found' } })
  })

  it('with location_id, the caller must hold landing_page there (403), whether or not the studio exists', async () => {
    const at = (loc) => GET(new Request(`http://localhost/api/landing-pages/slug-check?slug=january&location_id=${loc}`))
    expect((await at(STILL)).status).toBe(200)
    for (const loc of [HATCH, ELSEWHERE, 'a0000000-0000-0000-0000-0000000000ff']) expect((await at(loc)).status).toBe(403)
    expect(db.calls.filter((c) => c.table === 'locations' && c.eqs.some(([, v]) => v === HATCH))).toEqual([])
  })

  it('401 without a session; 503 when the read fails', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await check('january')).status).toBe(401)
    getCurrentUser.mockResolvedValue(STILL_MANAGER)
    createServerClient.mockReturnValue(fakeDb({ failures: { 'landing_pages.select': { message: 'boom' } } }))
    expect((await check('january')).status).toBe(503)
  })
})
