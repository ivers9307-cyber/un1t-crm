// GLOFOX-SPEC-2026-09 — `POST /v3.0/namespaces/members/retrieve` gained a
// `phone` filter (E.164, exact) in the September 2026 spec drop, alongside the
// original `email`. searchGlofoxMember is the one helper both lookups go
// through; searchGlofoxByEmail stays as the email-only wrapper every existing
// caller (and their mocks) already know.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const creds = { branchId: 'b', apiKey: 'k', apiToken: 't' }

const res = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => null },
  json: async () => body,
  clone() { return this },
})

const row = (over = {}) => ({
  id: '507f1f77bcf86cd799439011', _id: '507f1f77bcf86cd799439011',
  email: 'user@example.com', phone: '+353871234567', type: 'MEMBER',
  namespace: 'untstillorgan', branch_id: ['b'], origin_branch_id: 'b',
  ...over,
})

const sentBody = () => JSON.parse(global.fetch.mock.calls[0][1].body)

describe('searchGlofoxMember', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()))
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

  it('searches by email only, lowercased, and returns the exact match', async () => {
    const { searchGlofoxMember } = await import('./glofox.js')
    global.fetch.mockResolvedValueOnce(res(200, { data: [row()] }))
    const r = await searchGlofoxMember(creds, { email: ' User@Example.com ' })
    expect(global.fetch.mock.calls[0][0]).toContain('/v3.0/namespaces/members/retrieve')
    expect(sentBody()).toEqual({ email: 'user@example.com' })
    expect(r).toEqual({ found: true, member: row(), error: null })
  })

  it('searches by phone only, normalised to E.164, and matches on the returned phone', async () => {
    const { searchGlofoxMember } = await import('./glofox.js')
    global.fetch.mockResolvedValueOnce(res(200, { data: [row()] }))
    const r = await searchGlofoxMember(creds, { phone: '087 123 4567' })
    expect(sentBody()).toEqual({ phone: '+353871234567' })
    expect(r.found).toBe(true)
    expect(r.member._id).toBe('507f1f77bcf86cd799439011')
  })

  it('sends both filters when both are given and requires both to match', async () => {
    const { searchGlofoxMember } = await import('./glofox.js')
    // Glofox says a two-filter search ANDs them; defend locally too, so a
    // fuzzy upstream match on one field can never pass as a person match.
    global.fetch.mockResolvedValueOnce(res(200, { data: [row({ phone: '+353879999999' })] }))
    const r = await searchGlofoxMember(creds, { email: 'user@example.com', phone: '+353871234567' })
    expect(sentBody()).toEqual({ email: 'user@example.com', phone: '+353871234567' })
    expect(r).toEqual({ found: false, member: null, error: null })
  })

  it('refuses to call Glofox with neither a usable email nor a mobile-shaped phone', async () => {
    const { searchGlofoxMember } = await import('./glofox.js')
    expect(await searchGlofoxMember(creds, {})).toEqual({ found: false, member: null, error: 'missing args' })
    // A landline / placeholder is not a phone Glofox can match on.
    expect(await searchGlofoxMember(creds, { phone: '01 234 5678' })).toEqual({ found: false, member: null, error: 'missing args' })
    expect(await searchGlofoxMember(null, { email: 'a@b.ie' })).toEqual({ found: false, member: null, error: 'missing args' })
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('returns found:false with no error when the search comes back empty', async () => {
    const { searchGlofoxMember } = await import('./glofox.js')
    global.fetch.mockResolvedValueOnce(res(200, { data: [] }))
    expect(await searchGlofoxMember(creds, { phone: '+353871234567' })).toEqual({ found: false, member: null, error: null })
  })

  it('flags multiple exact matches for operator review, first match as the default', async () => {
    const { searchGlofoxMember } = await import('./glofox.js')
    const a = row(), b = row({ id: '507f1f77bcf86cd799439012', _id: '507f1f77bcf86cd799439012', email: 'other@example.com' })
    global.fetch.mockResolvedValueOnce(res(200, { data: [a, b] }))
    const r = await searchGlofoxMember(creds, { phone: '+353871234567' })
    expect(r.found).toBe(true)
    expect(r.error).toBe('multiple_glofox_matches')
    expect(r.member).toEqual(a)
    expect(r.allMatches).toEqual([a, b])
  })

  it('reports a non-2xx as an error, never as "no match"', async () => {
    const { searchGlofoxMember } = await import('./glofox.js')
    // 404, deliberately: glofoxFetch retries 429/5xx with backoff (a single
    // mocked response would drain into a fetch-undefined error), and 401/403
    // trigger the legacy fallback below. 404 is the plain "reported as-is" case.
    global.fetch.mockResolvedValueOnce(res(404, {}))
    expect(await searchGlofoxMember(creds, { email: 'user@example.com' })).toEqual({ found: false, member: null, error: 'Glofox HTTP 404' })
  })
})

// Live probe 2026-09-12: `POST /v3.0/namespaces/members/retrieve` answers
// 401 UNAUTHORIZED for our integrator in every shape (email-only included),
// while every other v3 endpoint we use still works. The last prod call that
// succeeded was 7 Sep; the spec re-drop landed 12 Sep. Two authorised
// alternatives exist and were verified live: the documented
// `GET /2.1/branches/{id}/users?filters[email]=` (exact email) and
// `GET /2.0/members?phone=` (exact match on the RAW stored string, so the
// national "0830622786" hits and "+353830622786" does not).
describe('searchGlofoxMember — fallback when the namespace search is not authorised', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()))
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

  const urls = () => global.fetch.mock.calls.map((c) => c[0])
  const legacyRow = (over = {}) => ({ _id: '69f7ac949ecb4625e305afad', email: 'user@example.com', phone: '0871234567', type: 'member', ...over })

  it('email: falls back to the documented 2.1 email filter on a 401 and links on _id', async () => {
    const { searchGlofoxMember } = await import('./glofox.js')
    global.fetch
      .mockResolvedValueOnce(res(401, { status: 'UNAUTHORIZED' }))
      .mockResolvedValueOnce(res(200, { data: [legacyRow()] }))
    const r = await searchGlofoxMember(creds, { email: 'User@Example.com' })
    expect(urls()[1]).toContain('/2.1/branches/b/users?filters%5Bemail%5D=user%40example.com')
    expect(r).toEqual({ found: true, member: legacyRow(), error: null })
  })

  it('phone: falls back to /2.0/members?phone= trying the national spelling first, then E.164 forms', async () => {
    const { searchGlofoxMember } = await import('./glofox.js')
    global.fetch
      .mockResolvedValueOnce(res(401, {}))
      .mockResolvedValueOnce(res(200, { data: [] }))           // 0871234567 — miss
      .mockResolvedValueOnce(res(200, { data: [legacyRow({ phone: '+353871234567' })] })) // +353871234567 — hit
    const r = await searchGlofoxMember(creds, { phone: '087 123 4567' })
    expect(urls()[1]).toContain('/2.0/members?phone=0871234567')
    expect(urls()[2]).toContain('/2.0/members?phone=%2B353871234567')
    expect(urls()).toHaveLength(3) // stops at the first hit
    expect(r.found).toBe(true)
    expect(r.member._id).toBe('69f7ac949ecb4625e305afad')
  })

  it('phone: a row whose stored phone does not normalise to the asked number is not a match', async () => {
    const { searchGlofoxMember } = await import('./glofox.js')
    global.fetch
      .mockResolvedValueOnce(res(401, {}))
      .mockResolvedValueOnce(res(200, { data: [legacyRow({ phone: '0879999999' })] }))
      .mockResolvedValueOnce(res(200, { data: [] }))
      .mockResolvedValueOnce(res(200, { data: [] }))
      .mockResolvedValueOnce(res(200, { data: [] }))
    const r = await searchGlofoxMember(creds, { phone: '0871234567' })
    expect(r).toEqual({ found: false, member: null, error: null })
  })

  it('both: under fallback the email filter runs and the row must also carry the phone', async () => {
    const { searchGlofoxMember } = await import('./glofox.js')
    global.fetch
      .mockResolvedValueOnce(res(403, {}))
      .mockResolvedValueOnce(res(200, { data: [legacyRow({ phone: '0879999999' })] }))
    const r = await searchGlofoxMember(creds, { email: 'user@example.com', phone: '0871234567' })
    expect(urls()).toHaveLength(2)
    expect(r).toEqual({ found: false, member: null, error: null })
  })

  it('a fallback that itself fails is reported, never read as "no match"', async () => {
    const { searchGlofoxMember } = await import('./glofox.js')
    global.fetch
      .mockResolvedValueOnce(res(401, {}))
      .mockResolvedValueOnce(res(403, {}))
    expect(await searchGlofoxMember(creds, { email: 'user@example.com' })).toEqual({ found: false, member: null, error: 'Glofox HTTP 403' })
  })

  it('v3 rows that carry `id` but no `_id` are given `_id`, so callers can link on it', async () => {
    const { searchGlofoxMember } = await import('./glofox.js')
    const v3 = { id: '507f1f77bcf86cd799439011', email: 'user@example.com', phone: '+353871234567', type: 'MEMBER' }
    global.fetch.mockResolvedValueOnce(res(200, { data: [v3] }))
    const r = await searchGlofoxMember(creds, { email: 'user@example.com' })
    expect(r.member._id).toBe('507f1f77bcf86cd799439011')
  })
})

describe('searchGlofoxByEmail (unchanged wrapper)', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()))
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

  it('still posts an email-only body and returns the same shape as before', async () => {
    const { searchGlofoxByEmail } = await import('./glofox.js')
    global.fetch.mockResolvedValueOnce(res(200, { data: [row()] }))
    const r = await searchGlofoxByEmail(creds, 'User@Example.com')
    expect(sentBody()).toEqual({ email: 'user@example.com' })
    expect(r).toEqual({ found: true, member: row(), error: null })
  })
})
