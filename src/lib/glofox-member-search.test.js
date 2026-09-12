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
    // 403, not 5xx: glofoxFetch retries 429/5xx with backoff, which would
    // drain a single mocked response and turn this into a fetch-undefined
    // error — a different (also non-"no match") failure than the one under test.
    global.fetch.mockResolvedValueOnce(res(403, {}))
    expect(await searchGlofoxMember(creds, { email: 'user@example.com' })).toEqual({ found: false, member: null, error: 'Glofox HTTP 403' })
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
