// MIAORG.1 Task 2 — the follow-up and check-in runners read Mia's settings
// through the resolver, per location, one org read per organisation per tick.
// The on/off switches stay the STUDIO's own: an org layer with followups /
// check-ins on never starts sends at a studio that is off. Fictional ids.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/location-branding', () => ({ getLocationBranding: vi.fn().mockResolvedValue({ companyName: 'UN1T' }) }))

import { runAgentFollowups, runFirstClassCheckins } from './followups'
import { STILLORGAN_BLOB, ORG_LAYER } from './settings-fixtures.test-helpers'

const ORG = 'b0000000-0000-0000-0000-0000000000b1'
const STILL = 'a0000000-0000-0000-0000-0000000000a1'
const HATCH = 'a0000000-0000-0000-0000-0000000000a2'
const NOW = Date.UTC(2026, 9, 14, 12, 0, 0) // 13:00 Dublin

// Records every query as { table, filters }; candidate queries answer empty.
function tickDb({ locations, org }) {
  const queries = []
  return {
    queries,
    from(table) {
      const q = { table, filters: {} }
      queries.push(q)
      const finish = () => {
        if (table === 'location_whatsapp_numbers') return { data: locations.map((l) => ({ location_id: l.id })), error: null } // MIAORG.1 Task 6 / WAORGNUMBER.1: a number is switched on at the studio
        if (table === 'locations') return { data: locations, error: null }
        if (table === 'org_settings') return { data: org == null ? null : { customer_agent: org }, error: null }
        return { data: [], error: null }
      }
      const b = {
        select: () => b, in: () => b, gte: () => b, lte: () => b, lt: () => b, is: () => b, not: () => b, or: () => b, order: () => b, limit: () => b,
        update: () => b,
        eq: (k, v) => { q.filters[k] = v; return b },
        maybeSingle: () => Promise.resolve(finish()),
        then: (ok, bad) => Promise.resolve(finish()).then(ok, bad),
      }
      return b
    },
  }
}
const loc = (id, customerAgent) => ({ id, name: id, organization_id: ORG, settings: customerAgent === undefined ? {} : { customer_agent: customerAgent } })
// The studios a runner got past its gates for (it then queries that table there).
const candidateReads = (db, table) => [...new Set(db.queries.filter((q) => q.table === table && q.filters.location_id).map((q) => q.filters.location_id))]

let warn
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

describe('runAgentFollowups — resolved settings', () => {
  it('an org with follow-ups on (and enabled:true) never starts follow-ups at a studio that is off', async () => {
    const db = tickDb({ locations: [loc(HATCH, undefined), loc(STILL, { enabled: false, test_mode: false })], org: ORG_LAYER })
    await runAgentFollowups(db, { nowMs: NOW })
    expect(candidateReads(db, 'whatsapp_conversations')).toEqual([])
  })

  it('an org-only followups.enabled reaches a live studio whose own blob has no followups', async () => {
    const studio = { ...STILLORGAN_BLOB }
    delete studio.followups
    const db = tickDb({ locations: [loc(STILL, studio)], org: { followups: { enabled: true } } })
    await runAgentFollowups(db, { nowMs: NOW })
    expect(candidateReads(db, 'whatsapp_conversations')).toEqual([STILL])
  })

  it('an org-only quiet_hours closes the proactive window for a studio that sets none', async () => {
    const db = tickDb({ locations: [loc(STILL, STILLORGAN_BLOB)], org: { quiet_hours: { start: '12:00', end: '14:00', tz: null } } })
    await runAgentFollowups(db, { nowMs: NOW })
    expect(candidateReads(db, 'whatsapp_conversations')).toEqual([])
    expect(warn.mock.calls.some((c) => String(c[1]).includes('operator_quiet_hours'))).toBe(true)
  })

  it("no behaviour change: Stillorgan's blob runs, Hatch (no blob) does not, org layer null", async () => {
    const db = tickDb({ locations: [loc(STILL, STILLORGAN_BLOB), loc(HATCH, undefined)], org: null })
    await runAgentFollowups(db, { nowMs: NOW })
    expect(candidateReads(db, 'whatsapp_conversations')).toEqual([STILL])
  })

  it('reads the org layer once per organisation per tick, not once per studio', async () => {
    const db = tickDb({ locations: [loc(STILL, STILLORGAN_BLOB), loc(HATCH, undefined), loc('a3', undefined)], org: null })
    await runAgentFollowups(db, { nowMs: NOW })
    expect(db.queries.filter((q) => q.table === 'org_settings')).toHaveLength(1)
  })
})

describe('runFirstClassCheckins — resolved settings', () => {
  it('an org with check-ins on (and enabled:true) never starts check-ins at a studio that is off', async () => {
    const db = tickDb({ locations: [loc(HATCH, undefined)], org: ORG_LAYER })
    await runFirstClassCheckins(db, { nowMs: NOW })
    expect(candidateReads(db, 'contacts')).toEqual([])
  })

  it('an org-only first_class_checkin.enabled reaches a live studio whose blob has none', async () => {
    const studio = { ...STILLORGAN_BLOB }
    delete studio.first_class_checkin
    const db = tickDb({ locations: [loc(STILL, studio)], org: { first_class_checkin: { enabled: true } } })
    await runFirstClassCheckins(db, { nowMs: NOW })
    expect(candidateReads(db, 'contacts')).toEqual([STILL])
  })

  it("no behaviour change: Stillorgan's blob runs, Hatch (no blob) does not, org layer null", async () => {
    const db = tickDb({ locations: [loc(STILL, STILLORGAN_BLOB), loc(HATCH, undefined)], org: null })
    await runFirstClassCheckins(db, { nowMs: NOW })
    expect(candidateReads(db, 'contacts')).toEqual([STILL])
  })
})
