// MIAORG.1 Task 2 — the handoff SLA sweep and the auto-resolve sweep read Mia's
// settings through the resolver (one org read per organisation per tick), but
// still sweep only a studio that has ITS OWN customer_agent config: resolved
// settings always exist (DEFAULTS), so gating on them would sweep every studio
// that never set Mia up. Fictional ids.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/push', () => ({ sendPushToRolesAtLocation: vi.fn() }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))

const { runHandoffSlaSweep, runHandoffAutoResolve } = await import('./handoff-sla')
const { STILLORGAN_BLOB } = await import('./settings-fixtures.test-helpers')

const ORG = 'b0000000-0000-0000-0000-0000000000b1'
const STILL = 'a0000000-0000-0000-0000-0000000000a1'
const HATCH = 'a0000000-0000-0000-0000-0000000000a2'
const TESTSTUDIO = 'a0000000-0000-0000-0000-0000000000a3'
const NOW = Date.parse('2026-10-14T12:00:00Z')

function sweepDb({ locations, org }) {
  const queries = []
  return {
    queries,
    from(table) {
      const q = { table, eqs: {}, lt: null }
      queries.push(q)
      const finish = () => {
        if (table === 'locations') return { data: locations, error: null }
        if (table === 'org_settings') return { data: org == null ? null : { customer_agent: org }, error: null }
        return { data: [], error: null }
      }
      const b = {
        select: () => b, gte: () => b, neq: () => b, not: () => b, or: () => b, order: () => b, limit: () => b, is: () => b,
        eq: (c, v) => { q.eqs[c] = v; return b },
        lt: (c, v) => { q.lt = v; return b },
        maybeSingle: () => Promise.resolve(finish()),
        then: (res, rej) => Promise.resolve(finish()).then(res, rej),
      }
      return b
    },
  }
}
const loc = (id, customerAgent) => ({ id, name: id, organization_id: ORG, settings: customerAgent === undefined ? {} : { customer_agent: customerAgent } })
const swept = (db) => [...new Set(db.queries.filter((q) => q.table === 'whatsapp_conversations' && q.eqs.location_id).map((q) => q.eqs.location_id))]
const cutoffFor = (db, id) => db.queries.find((q) => q.table === 'whatsapp_conversations' && q.eqs.location_id === id)?.lt

beforeEach(() => vi.clearAllMocks())

describe('runHandoffSlaSweep — resolved settings', () => {
  it('a studio with no customer_agent config is never swept, whatever the org layer holds', async () => {
    const db = sweepDb({ locations: [loc(HATCH, undefined)], org: { handoff_sla_minutes: 30, enabled: true } })
    await runHandoffSlaSweep(db, { nowMs: NOW })
    expect(swept(db)).toEqual([])
  })

  it('an org-only handoff_sla_minutes reaches a studio whose blob sets none', async () => {
    const db = sweepDb({ locations: [loc(STILL, STILLORGAN_BLOB)], org: { handoff_sla_minutes: 30 } })
    await runHandoffSlaSweep(db, { nowMs: NOW })
    expect(cutoffFor(db, STILL)).toBe(new Date(NOW - 30 * 60_000).toISOString())
  })

  it('no behaviour change (org null): Stillorgan and a studio with a partial blob sweep at 60 min; Hatch does not', async () => {
    const db = sweepDb({ locations: [loc(STILL, STILLORGAN_BLOB), loc(HATCH, undefined), loc(TESTSTUDIO, { monthly_points_target: 3000 })], org: null })
    await runHandoffSlaSweep(db, { nowMs: NOW })
    expect(swept(db)).toEqual([STILL, TESTSTUDIO])
    expect(cutoffFor(db, STILL)).toBe(new Date(NOW - 60 * 60_000).toISOString())
    expect(db.queries.filter((q) => q.table === 'org_settings')).toHaveLength(1)
  })
})

describe('runHandoffAutoResolve — resolved settings', () => {
  it('a studio with no customer_agent config is never auto-resolved, whatever the org layer holds', async () => {
    const db = sweepDb({ locations: [loc(HATCH, undefined)], org: { auto_resolve_stale_hours: 24 } })
    await runHandoffAutoResolve(db, { nowMs: NOW })
    expect(swept(db)).toEqual([])
  })

  it('an org that switches both cases off (0) reaches a studio whose blob sets neither', async () => {
    const db = sweepDb({ locations: [loc(STILL, STILLORGAN_BLOB)], org: { auto_resolve_after_reply_hours: 0, auto_resolve_stale_hours: 0 } })
    await runHandoffAutoResolve(db, { nowMs: NOW })
    expect(swept(db)).toEqual([])
  })

  it('no behaviour change (org null): Stillorgan and the partial blob run on the 8h/48h defaults; Hatch does not', async () => {
    const db = sweepDb({ locations: [loc(STILL, STILLORGAN_BLOB), loc(HATCH, undefined), loc(TESTSTUDIO, { monthly_points_target: 3000 })], org: null })
    await runHandoffAutoResolve(db, { nowMs: NOW })
    expect(swept(db)).toEqual([STILL, TESTSTUDIO])
    expect(db.queries.filter((q) => q.table === 'org_settings')).toHaveLength(1)
  })
})
