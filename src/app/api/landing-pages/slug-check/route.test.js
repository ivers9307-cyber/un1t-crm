// PAGES.1 — GET /api/landing-pages/slug-check?slug=: whether a path is free in
// the caller's active organisation (the New page form's pre-check).

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))

const { createServerClient } = await import('@/lib/supabase')
const { getCurrentUser } = await import('@/lib/auth')
const { GET } = await import('./route.js')
const { fakeDb, STILL_MANAGER, ORG, OTHER_ORG } = await import('../../../../../tests/helpers/landing-pages-fixtures.js')

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

  it('401 without a session; 503 when the read fails', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await check('january')).status).toBe(401)
    getCurrentUser.mockResolvedValue(STILL_MANAGER)
    createServerClient.mockReturnValue(fakeDb({ failures: { 'landing_pages.select': { message: 'boom' } } }))
    expect((await check('january')).status).toBe(503)
  })
})
