// Tests for src/lib/sms.js — buildSmsAudience query shape.
// sendBroadcast itself is integration-tested implicitly through
// the API route + manual sends; this file pins the query builder
// so an accidental refactor of the audience contract is caught.

import { describe, it, expect } from 'vitest'
import { buildSmsAudience, buildSmsAudienceAsync, fetchAllSmsAudience } from './sms.js'

// Minimal Supabase-like fluent builder fake so we can assert
// which methods got called with which args. Each call returns the
// same object so chains compose.
function makeFakeQuery() {
  const calls = []
  const builder = new Proxy({}, {
    get(_, method) {
      return (...args) => {
        calls.push({ method, args })
        return builder
      }
    },
  })
  return { builder, calls }
}

describe('buildSmsAudience', () => {
  it('starts at the contacts table and applies the standard send-eligibility gates', () => {
    const { builder, calls } = makeFakeQuery()
    const db = { from: (t) => { calls.push({ method: 'from', args: [t] }); return builder } }

    buildSmsAudience(db, { logic: 'and', filters: [] }, 'loc-uuid')

    // Order of fluent calls matters for SQL clarity. Pin them so a
    // refactor that loosens the gates is caught immediately.
    expect(calls[0]).toEqual({ method: 'from', args: ['contacts'] })
    expect(calls[1].method).toBe('select')
    expect(calls[2]).toEqual({ method: 'eq', args: ['location_id', 'loc-uuid'] })
    expect(calls[3]).toEqual({ method: 'eq', args: ['sms_status', 'active'] })
    // Mig 064 — also gates on the marketing opt-in.
    expect(calls[4]).toEqual({ method: 'eq', args: ['contact_preferences.sms_marketing', true] })
    expect(calls[5]).toEqual({ method: 'not', args: ['phone', 'is', null] })
  })

  it('select() includes phone + sms_status + identity fields needed by the send loop', () => {
    const { builder, calls } = makeFakeQuery()
    const db = { from: () => builder }
    buildSmsAudience(db, { logic: 'and', filters: [] }, 'loc-uuid')

    const selectCall = calls.find(c => c.method === 'select')
    const cols = selectCall.args[0]
    expect(cols).toContain('phone')
    expect(cols).toContain('sms_status')
    expect(cols).toContain('first_name')
    expect(cols).toContain('name')
    expect(cols).toContain('pipeline_stage_slug')
    expect(cols).toContain('location_id')
    // Mig 064 — inner-join the preferences table so sms_marketing
    // can be filtered in the same query.
    expect(cols).toContain('contact_preferences!inner(sms_marketing)')
  })

  it('passes through to applyAudienceFilter for user filters (no field-name leakage)', () => {
    // applyAudienceFilter is the whitelisted helper; sms_status was
    // registered in mig 059's audience-filter update. We can't
    // execute the query here, but we can ensure buildSmsAudience
    // returns SOMETHING (not undefined) so the caller's await
    // doesn't crash even when the user's filter is empty.
    const { builder } = makeFakeQuery()
    const db = { from: () => builder }
    const out = buildSmsAudience(db, null, 'loc-uuid')
    expect(out).toBeDefined()
  })
})

describe('buildSmsAudienceAsync', () => {
  it('returns a wrapped { query } (resolves virtual fields via the async path)', async () => {
    const { builder } = makeFakeQuery()
    const db = { from: () => builder }
    const result = await buildSmsAudienceAsync(db, { logic: 'and', filters: [] }, 'loc-uuid')
    expect(result).toHaveProperty('query')
    expect(result.query).toBeDefined()
  })

  it('applies the same base eligibility gates as the sync builder', async () => {
    const { builder, calls } = makeFakeQuery()
    const db = { from: (t) => { calls.push({ method: 'from', args: [t] }); return builder } }
    await buildSmsAudienceAsync(db, { logic: 'and', filters: [] }, 'loc-uuid')
    expect(calls[0]).toEqual({ method: 'from', args: ['contacts'] })
    expect(calls).toContainEqual({ method: 'eq', args: ['sms_status', 'active'] })
    expect(calls).toContainEqual({ method: 'eq', args: ['contact_preferences.sms_marketing', true] })
    expect(calls).toContainEqual({ method: 'not', args: ['phone', 'is', null] })
  })
})

describe('fetchAllSmsAudience', () => {
  // Fluent fake whose terminal .range() resolves to the next configured page;
  // every other method returns the builder so the base gates + applyAudienceFilter
  // chain composes. No `then`, so the builder itself is never auto-awaited.
  function fakeAudienceDb(pages) {
    let i = 0
    const builder = new Proxy({}, {
      get(_, prop) {
        if (prop === 'range') return () => Promise.resolve({ data: pages[i++] ?? [], error: null })
        if (prop === 'then') return undefined
        return () => builder
      },
    })
    return { from: () => builder }
  }

  it('returns a single short page without paging again', async () => {
    const db = fakeAudienceDb([[{ id: 'a' }, { id: 'b' }]])
    const rows = await fetchAllSmsAudience(db, { logic: 'and', filters: [] }, 'loc')
    expect(rows.map(r => r.id)).toEqual(['a', 'b'])
  })

  it('pages until a short page ends the loop', async () => {
    const full = Array.from({ length: 1000 }, (_, i) => ({ id: `p1-${i}` }))
    const db = fakeAudienceDb([full, [{ id: 'p2-0' }]]) // 1000 then 1 → stop after page 2
    const rows = await fetchAllSmsAudience(db, { logic: 'and', filters: [] }, 'loc')
    expect(rows).toHaveLength(1001)
    expect(rows[1000].id).toBe('p2-0')
  })
})
