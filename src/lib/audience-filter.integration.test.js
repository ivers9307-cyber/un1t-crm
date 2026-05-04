// Integration tests for resolveTagFilters (Phase 3 — mig 085).
//
// Uses the REAL @supabase/supabase-js client + the real postgrest-js
// query builder. Network is the only thing mocked: a global fetch
// stub captures the final URL (where PostgREST encodes the WHERE
// clauses) and returns canned data. This sidesteps the flaky
// PromiseLike-chain mocking that the unit-level tests punted on.
//
// What this tests:
//   - The real chain semantics are honoured (await actually settles)
//   - Tag clauses translate into the expected PostgREST URL params
//     (`id=in.(...)`, `id=not.in.(...)`, `id=eq.<sentinel>`)
//   - Multiple positive tags intersect correctly
//   - Negative tags subtract via NOT IN
//   - Empty intersection collapses to the sentinel predicate
//
// What this does NOT test:
//   - That the SQL produced by PostgREST returns correct rows
//     (that's PostgREST's responsibility — we trust their parser)
//   - The full /api/contacts/search route handler (separate test)

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import { resolveTagFilters } from './audience-filter.js'

const FAKE_SUPABASE_URL = 'https://test.supabase.co'
const FAKE_KEY = 'fake-anon-key'

// Captures every fetch call across a test so assertions can pick the
// one they care about (contact_tags lookup vs final contacts query).
let fetchCalls = []
let originalFetch

// Tiny PostgREST response — fields shaped like a Supabase select.
function jsonResponse(data, init = {}) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'content-type': 'application/json', ...(init.headers || {}) },
    ...init,
  })
}

// Fetch stub — dispatches by URL substring so different tables can
// return different canned data.
function installFetch({ tagToContactIds = {}, contactsResponse = [] } = {}) {
  globalThis.fetch = vi.fn(async (input, init) => {
    const url = typeof input === 'string' ? input : input.url
    fetchCalls.push({ url, method: init?.method || 'GET', headers: init?.headers, body: init?.body })

    if (url.includes('/rest/v1/contact_tags')) {
      // Pull the tag from the URL (?tag=eq.<value>&...).
      const m = url.match(/[?&]tag=eq\.([^&]+)/)
      const tag = m ? decodeURIComponent(m[1]) : null
      const ids = (tagToContactIds[tag] || []).map((id) => ({ contact_id: id }))
      return jsonResponse(ids)
    }
    if (url.includes('/rest/v1/contacts')) {
      return jsonResponse(contactsResponse)
    }
    return jsonResponse([])
  })
}

beforeEach(() => {
  fetchCalls = []
  originalFetch = globalThis.fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

function makeDb() {
  return createClient(FAKE_SUPABASE_URL, FAKE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

// Pull the URL of the FINAL contacts request — that's the one
// resolveTagFilters has narrowed via .in() / .not() / .eq().
// URL-decoded so assertions don't have to deal with %28 / %2C.
function lastContactsUrl() {
  for (let i = fetchCalls.length - 1; i >= 0; i--) {
    if (fetchCalls[i].url.includes('/rest/v1/contacts')) {
      try { return decodeURIComponent(fetchCalls[i].url) } catch { return fetchCalls[i].url }
    }
  }
  return null
}

describe('resolveTagFilters — integration with real Supabase client', () => {
  it('passes through unchanged when no tag filters are present', async () => {
    installFetch({ contactsResponse: [{ id: 'c1' }] })
    const db = makeDb()
    const baseQuery = db.from('contacts').select('id').eq('location_id', 'loc-A')

    const out = await resolveTagFilters({
      db,
      query: baseQuery,
      filter: { filters: [{ field: 'lead_status', op: 'eq', value: 'member' }] },
      locationId: 'loc-A',
    })
    // Trigger the contacts request to inspect the final URL.
    await out
    const url = lastContactsUrl()
    expect(url).toBeTruthy()
    expect(url).not.toContain('id=in.')
    expect(url).not.toContain('id=not.in.')
    // No contact_tags lookup happened.
    expect(fetchCalls.some(c => c.url.includes('/contact_tags'))).toBe(false)
  })

  it('applies an id=in.(…) constraint for an eq tag filter', async () => {
    installFetch({ tagToContactIds: { race_completed: ['c1', 'c2', 'c3'] }, contactsResponse: [] })
    const db = makeDb()
    const baseQuery = db.from('contacts').select('id').eq('location_id', 'loc-A')

    const out = await resolveTagFilters({
      db,
      query: baseQuery,
      filter: { filters: [{ field: 'tag', op: 'eq', value: 'race_completed' }] },
      locationId: 'loc-A',
    })
    await out
    const url = lastContactsUrl()
    expect(url).toMatch(/id=in\.\(/)
    // PostgREST URL-encodes the parens as %28/%29 in some clients
    // and leaves them bare in others — match either.
    expect(url).toMatch(/c1[,%2C]c2[,%2C]c3/)
    // Tag lookup hit contact_tags with the right tag + active filter.
    const tagCall = fetchCalls.find(c => c.url.includes('/contact_tags'))
    expect(tagCall).toBeTruthy()
    expect(tagCall.url).toContain('tag=eq.race_completed')
    expect(tagCall.url).toContain('removed_at=is.null')
    expect(tagCall.url).toContain('location_id=eq.loc-A')
  })

  it('intersects two positive tags AND together at the URL level', async () => {
    installFetch({
      tagToContactIds: {
        race_completed: ['c1', 'c2', 'c3'],
        repeat_racer:   ['c2', 'c3', 'c4'],
      },
      contactsResponse: [],
    })
    const db = makeDb()
    const baseQuery = db.from('contacts').select('id').eq('location_id', 'loc-A')

    const out = await resolveTagFilters({
      db,
      query: baseQuery,
      filter: {
        filters: [
          { field: 'tag', op: 'eq', value: 'race_completed' },
          { field: 'tag', op: 'eq', value: 'repeat_racer' },
        ],
      },
      locationId: 'loc-A',
    })
    await out
    const url = lastContactsUrl()
    // Intersection of {c1,c2,c3} ∩ {c2,c3,c4} = {c2,c3}.
    expect(url).toMatch(/id=in\.\(/)
    expect(url).toMatch(/c2/)
    expect(url).toMatch(/c3/)
    expect(url).not.toMatch(/c1/)
    expect(url).not.toMatch(/c4/)
  })

  it('forces an unsatisfiable predicate when an eq tag matches no contacts', async () => {
    installFetch({ tagToContactIds: { rare_tag: [] }, contactsResponse: [] })
    const db = makeDb()
    const baseQuery = db.from('contacts').select('id').eq('location_id', 'loc-A')

    const out = await resolveTagFilters({
      db,
      query: baseQuery,
      filter: { filters: [{ field: 'tag', op: 'eq', value: 'rare_tag' }] },
      locationId: 'loc-A',
    })
    await out
    const url = lastContactsUrl()
    // Sentinel: id=eq.00000000-0000-0000-0000-000000000000
    expect(url).toContain('id=eq.00000000-0000-0000-0000-000000000000')
  })

  it('applies a NOT IN exclusion for a neq tag filter', async () => {
    installFetch({ tagToContactIds: { lapsed_payer: ['c1', 'c5'] }, contactsResponse: [] })
    const db = makeDb()
    const baseQuery = db.from('contacts').select('id').eq('location_id', 'loc-A')

    const out = await resolveTagFilters({
      db,
      query: baseQuery,
      filter: { filters: [{ field: 'tag', op: 'neq', value: 'lapsed_payer' }] },
      locationId: 'loc-A',
    })
    await out
    const url = lastContactsUrl()
    // PostgREST renders a NOT IN as id=not.in.(c1,c5)
    expect(url).toMatch(/id=not\.in\.\(/)
    expect(url).toMatch(/c1/)
    expect(url).toMatch(/c5/)
  })

  it('skips the tag lookup entirely when the filter has no tag clauses', async () => {
    installFetch({ contactsResponse: [] })
    const db = makeDb()
    const baseQuery = db.from('contacts').select('id').eq('location_id', 'loc-A')

    await resolveTagFilters({
      db,
      query: baseQuery,
      filter: { filters: [{ field: 'email', op: 'contains', value: 'gmail' }] },
      locationId: 'loc-A',
    })
    // Crucially: zero contact_tags lookups for non-tag filters.
    expect(fetchCalls.some(c => c.url.includes('/contact_tags'))).toBe(false)
  })

  it('combines positive eq with negative neq on the same query', async () => {
    installFetch({
      tagToContactIds: {
        race_completed: ['c1', 'c2', 'c3'],
        lapsed_payer:   ['c2'],  // c2 is in both — neq should exclude it
      },
      contactsResponse: [],
    })
    const db = makeDb()
    const baseQuery = db.from('contacts').select('id').eq('location_id', 'loc-A')

    const out = await resolveTagFilters({
      db,
      query: baseQuery,
      filter: {
        filters: [
          { field: 'tag', op: 'eq', value: 'race_completed' },
          { field: 'tag', op: 'neq', value: 'lapsed_payer' },
        ],
      },
      locationId: 'loc-A',
    })
    await out
    const url = lastContactsUrl()
    // Positive narrows to {c1,c2,c3}, then NOT IN excludes c2.
    // The IN clause is applied first.
    expect(url).toMatch(/id=in\.\(/)
    expect(url).toMatch(/id=not\.in\.\(/)
    expect(url).toMatch(/c2/) // appears in both clauses; PostgREST's
                              // not.in.(c2) is the actual exclusion.
  })
})
