// SAAS-3 — test-only fixtures for the per-org API key tests.
//
// makeFakeDb() is a filter-AWARE in-memory Supabase double: unlike the
// usual canned-result mocks, .eq/.in/.is really filter rows, so an
// org-scoping test fails if a route forgets the location filter (the
// leak we're guarding against) rather than passing vacuously. Not
// imported by any prod code — Next never bundles it.

import { hashApiKey } from './api-keys.js'

/**
 * Minimal chainable supabase-js double over in-memory tables.
 * Supports the subset the API-key routes use: select/eq/neq/is/in/
 * gte/lte/ilike/order/limit/range/update/insert + maybeSingle/single
 * and thenable awaiting. Updates mutate the fixture rows in place so
 * tests can assert on (non-)mutation.
 *
 * @param {Record<string, object[]>} tables — mutated by insert/update
 */
export function makeFakeDb(tables) {
  function from(table) {
    const source = tables[table] || (tables[table] = [])
    let matched = [...source]
    let patch = null
    const apply = () => {
      if (patch) for (const row of matched) Object.assign(row, patch)
      return matched
    }
    const b = {}
    const chain = (fn) => (...args) => { fn(...args); return b }
    b.select = chain(() => {})
    b.order = chain(() => {})
    b.limit = chain((n) => { matched = matched.slice(0, n) })
    b.range = chain((lo, hi) => { matched = matched.slice(lo, hi + 1) })
    b.eq = chain((col, val) => { matched = matched.filter((r) => r[col] === val) })
    b.neq = chain((col, val) => { matched = matched.filter((r) => r[col] !== val) })
    b.is = chain((col, val) => { matched = matched.filter((r) => (r[col] ?? null) === val) })
    b.in = chain((col, vals) => { matched = matched.filter((r) => vals.includes(r[col])) })
    b.gte = chain((col, val) => { matched = matched.filter((r) => r[col] >= val) })
    b.lte = chain((col, val) => { matched = matched.filter((r) => r[col] <= val) })
    b.ilike = chain((col, pat) => {
      const needle = String(pat).replaceAll('%', '').toLowerCase()
      matched = matched.filter((r) => String(r[col] ?? '').toLowerCase().includes(needle))
    })
    b.update = chain((p) => { patch = p })
    b.insert = chain((rows) => {
      const arr = Array.isArray(rows) ? rows : [rows]
      source.push(...arr)
      matched = arr
    })
    b.maybeSingle = async () => ({ data: apply()[0] ?? null, error: null })
    b.single = async () => {
      const rows = apply()
      return rows.length === 1
        ? { data: rows[0], error: null }
        : { data: null, error: { message: `expected 1 row, got ${rows.length}` } }
    }
    b.then = (resolve, reject) => Promise.resolve({ data: apply(), error: null }).then(resolve, reject)
    return b
  }
  return { from }
}

// Raw bearer tokens. GLOBAL_KEY stands in for the legacy shared
// CRM_API_KEY (stub the env to it); the unitk_ keys resolve against the
// api_keys fixture rows below by real SHA-256 hash.
export const GLOBAL_KEY = 'legacy-shared-crm-key-0123456789abcdef0123456789abcdef01234567'
export const ORG1_KEY = 'unitk_' + '1'.repeat(40)
export const ORG2_KEY_REVOKED = 'unitk_' + '2'.repeat(40)
export const EMPTY_ORG_KEY = 'unitk_' + '3'.repeat(40) // active key, org with zero locations
export const UNKNOWN_KEY = 'unitk_' + 'f'.repeat(40) // no api_keys row

/**
 * Two-org fixture: org-1 (loc-1a, loc-1b) and org-2 (loc-2a), one
 * booking + contact in each org. Fresh copy per call — updates mutate it.
 */
export function twoOrgFixture() {
  return {
    api_keys: [
      { id: 'key-1', organization_id: 'org-1', key_hash: hashApiKey(ORG1_KEY), revoked_at: null, last_used_at: null },
      { id: 'key-2', organization_id: 'org-2', key_hash: hashApiKey(ORG2_KEY_REVOKED), revoked_at: '2026-01-01T00:00:00.000Z', last_used_at: null },
      { id: 'key-3', organization_id: 'org-empty', key_hash: hashApiKey(EMPTY_ORG_KEY), revoked_at: null, last_used_at: null },
    ],
    locations: [
      { id: 'loc-1a', organization_id: 'org-1' },
      { id: 'loc-1b', organization_id: 'org-1' },
      { id: 'loc-2a', organization_id: 'org-2' },
    ],
    bookings: [
      { id: 'b1', location_id: 'loc-1a', status: 'pending', booking_date: '2026-08-01', start_time: '09:00' },
      { id: 'b2', location_id: 'loc-2a', status: 'pending', booking_date: '2026-08-01', start_time: '10:00' },
    ],
    contacts: [
      { id: 'c1', location_id: 'loc-1a', name: 'Org One Person', email: 'one@example.com' },
      { id: 'c2', location_id: 'loc-2a', name: 'Org Two Person', email: 'two@example.com' },
    ],
    campaigns: [
      { id: 'cam1', location_id: 'loc-1a', name: 'Org One Campaign', status: 'draft' },
      { id: 'cam2', location_id: 'loc-2a', name: 'Org Two Campaign', status: 'draft' },
    ],
    activities: [
      { id: 't1', location_id: 'loc-1a', kind: 'task', subject: 'Org one task', status: 'todo' },
      { id: 't2', location_id: 'loc-2a', kind: 'task', subject: 'Org two task', status: 'todo' },
    ],
  }
}
