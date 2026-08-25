// FILTER-C.5 — WhatsApp's "will receive" number comes from the SEND builder.
//
// FILTER-B.8 moved email and SMS onto buildEligibleAudienceQuery, which
// delegates to each channel's real send builder, so the count, the preview and
// the send resolve ONE query path by construction. WhatsApp was left computing
// its `reachable` its own way — same view, same five gates, but re-spelled at a
// second call site and applied in a different order relative to the operator's
// audience filter. Two definitions of one number is exactly how a preview and a
// send drift apart later; the SMS branch was fixed for the same reason.
//
// WhatsApp's extra gates are NOT an obstacle to unification: wa_status, the
// wa_phone-presence check and the per-location consent column all live inside
// applyWhatsAppReachability, which whatsAppAudienceBase (and therefore
// buildWhatsAppAudienceAsync, and therefore buildEligibleAudienceQuery) already
// applies. Template/session rules are not audience predicates — a broadcast
// sends a template, so there is no 24h window to filter on — and the blast-time
// frequency cap and resume set are post-query decisions the sender makes over
// the rows this query returns, identically for every channel.
//
// This test does not check a number; it checks that the two paths BUILD THE
// SAME QUERY. The real applyAudienceFilterAsync runs (deliberately not mocked)
// so the operator's filter predicates are part of the comparison.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { computeWhatsAppReachabilitySummary, buildWhatsAppAudienceAsync } from './whatsapp.js'

// CONSENTLOC-FLAKE.1 (class sweep) — FREEZE THE CLOCK. This file deep-equals
// the call log of TWO SEPARATE EXECUTIONS of the audience query builders, and
// applyAudienceFilter mints its own wall clock INSIDE the predicate for the
// `days_since_gt` / `days_since_lt` operators (audience-filter.js:381/387/584/594
// each do `const cutoff = new Date()` and embed `cutoff.toISOString()` at
// MILLISECOND precision). Two sequential builds therefore straddle a millisecond
// boundary every so often and emit cutoffs 1ms apart. The diff is one digit
// inside a predicate string, so vitest's truncated output prints two
// near-identical sides and reads as a mystery — the same signature as the
// marketing-consent flake that shipped a red build to production main.
//
// MEASURED on THIS path, replaying the assertion below with real timers:
// 37/3,000 and 46/3,000 (1.2-1.5%), i.e. roughly 1 CI run in 70 — an order of
// magnitude worse than the 0.055-0.095% the bare builder shows, because the
// summary side runs six queries between the two builds and widens the window.
// A matched-N control with the clock frozen was 0/3,000, and 0/20,000 on replay.
//
// This file's FILTER deliberately includes a `days_since_gt` predicate: a
// re-engagement audience ("hasn't attended in N days") is exactly the shape this
// parity test exists to cover, and pinning the clock is what keeps it exact.
// Do NOT delete this freeze to "simplify" — it is load-bearing for the one test
// that proves preview and send resolve a single query path.
const FROZEN_NOW = new Date('2026-08-19T10:00:00.000Z')
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'], now: FROZEN_NOW }) })
afterEach(() => { vi.useRealTimers() })

// Records every builder method call, in order, per query. Terminal await
// resolves to a configured count so the summary's arithmetic still runs.
function recordingDb(counts = []) {
  const queries = []
  let i = 0
  return {
    queries,
    db: {
      from(table) {
        const calls = []
        const value = { count: counts[i] ?? 0, data: [], error: null }
        i += 1
        queries.push({ table, calls })
        const builder = new Proxy({}, {
          get(_t, prop) {
            if (prop === 'then') return (resolve) => resolve(value)
            return (...args) => { calls.push([String(prop), ...args]); return builder }
          },
        })
        return builder
      },
    },
  }
}

const FILTER = {
  logic: 'and',
  filters: [
    { field: 'pipeline_stage_slug', op: 'eq', value: 'member' },
    // A NULL-inclusive negative — compiles to a chained .or(), which is where
    // predicate ORDER is most visible between two hand-built query paths.
    { field: 'glofox_membership_type', op: 'neq', value: 'time' },
    { field: 'total_attended_30d', op: 'gte', value: '2' },
    // A wall-clock predicate. `days_since_gt` compiles to a cutoff computed
    // from `new Date()` at call time, so it only compares equal across the two
    // builds because the clock is frozen above — which is the point: the
    // re-engagement filter an operator is most likely to add here is also the
    // one that would silently make this test flaky.
    { field: 'last_attended_at', op: 'days_since_gt', value: 30 },
  ],
}

const COUNT_OPTS = { columns: 'id', selectOpts: { count: 'exact', head: true } }

describe('WhatsApp reachable is the send builder\'s own query', () => {
  it('builds the reachable count through buildWhatsAppAudienceAsync, call for call', async () => {
    const summarySide = recordingDb([10, 6, 3, 2, 1, 4])
    await computeWhatsAppReachabilitySummary(summarySide.db, FILTER, 'loc-1')

    const sendSide = recordingDb([0])
    await buildWhatsAppAudienceAsync(sendSide.db, FILTER, 'loc-1', COUNT_OPTS)

    // Query 0 is `matched` (filter only); query 1 is `reachable`.
    const reachable = summarySide.queries[1]
    const send = sendSide.queries[0]
    expect(reachable.table).toBe(send.table)
    expect(reachable.calls).toEqual(send.calls)
  })

  it('still returns matched, reachable and the four exclusion reasons', async () => {
    const { db } = recordingDb([10, 6, 3, 2, 1, 4])
    const out = await computeWhatsAppReachabilitySummary(db, FILTER, 'loc-1')
    expect(out).toEqual({
      matched: 10,
      reachable: 6,
      excluded: { no_number: 3, no_consent: 2, opted_out: 1, undeliverable: 4 },
    })
  })

  it('the reachable query carries the WhatsApp gates the send applies', async () => {
    const { db, queries } = recordingDb([0, 0, 0, 0, 0, 0])
    await computeWhatsAppReachabilitySummary(db, FILTER, 'loc-1')
    const calls = queries[1].calls.map(c => JSON.stringify(c))
    expect(calls).toContain(JSON.stringify(['eq', 'loc_whatsapp_marketing', true]))
    expect(calls).toContain(JSON.stringify(['not', 'wa_phone', 'is', null]))
    expect(calls).toContain(JSON.stringify(['neq', 'wa_status', 'blocked']))
    expect(calls).toContain(JSON.stringify(['neq', 'wa_status', 'opted_out']))
    expect(calls).toContain(JSON.stringify(['neq', 'wa_status', 'undeliverable']))
    // …and it is a head-only count over the per-location audience view.
    expect(queries[1].table).toBe('contact_location_audience')
    expect(queries[1].calls[0]).toEqual(['select', 'id', { count: 'exact', head: true }])
  })
})
