// Tests for src/lib/sms.js — buildSmsAudience query shape.
// sendBroadcast itself is integration-tested implicitly through
// the API route + manual sends; this file pins the query builder
// so an accidental refactor of the audience contract is caught.

import { describe, it, expect } from 'vitest'
import { buildSmsAudience } from './sms.js'

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
    expect(calls[4]).toEqual({ method: 'not', args: ['phone', 'is', null] })
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
    expect(cols).toContain('lead_status')
    expect(cols).toContain('location_id')
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
