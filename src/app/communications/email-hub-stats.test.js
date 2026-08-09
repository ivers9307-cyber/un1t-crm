// COMMSFIX.C.6 — two hub numbers that were structurally wrong.
//
//   1. "Active sequences" counted email_sequences.active — the DEAD column.
//      `status` is truth (established invariant; live data has active=false on
//      the sequence whose status IS 'active'). This was the last reader of the
//      column anywhere in the repo, so the card showed a number nothing
//      maintains: 0 while three sequences run, or a count of long-paused ones.
//
//   2. "Open rate" divided ALL email_sends at the location by the opened ones.
//      Since EMAIL-NOTRACK.1 (2026-08-07) TrackOpens is explicitly OFF for
//      every non-broadcast stream, so ticket replies, invoices and sequences'
//      administrative mail CAN NEVER register an open while still inflating the
//      denominator. The stat drifts down as transactional volume grows, for a
//      reason invisible to whoever reads it.
//
// Extracted from page.js as a pure loader: the page holds JSX in a .js file,
// which the repo's node-environment vitest cannot import.

import { describe, it, expect } from 'vitest'
import { loadEmailHubStats } from './email-hub-stats.js'

const LOC = 'loc-1'

// Records every query so the test can assert the FILTERS, which are the whole
// feature here — a fake that no-ops them would pass with both bugs intact.
function makeDb(counts) {
  const queries = []
  return {
    queries,
    from(table) {
      const q = { table, filters: [], not: [] }
      queries.push(q)
      const api = {
        select() { return api },
        eq(col, val) { q.filters.push([col, val]); return api },
        not(col, op, val) { q.not.push([col, op, val]); return api },
        then(resolve, reject) {
          const key = q.table === 'email_sequences'
            ? 'sequences'
            : q.not.length ? 'opened' : 'sent'
          return Promise.resolve({ count: counts[key] ?? 0 }).then(resolve, reject)
        },
      }
      return api
    },
  }
}

const findQuery = (db, table, opened = false) =>
  db.queries.find(q => q.table === table && (opened ? q.not.length > 0 : q.not.length === 0))

describe('loadEmailHubStats (COMMSFIX.C.6)', () => {
  it('counts active sequences by status, never by the dead active column', async () => {
    const db = makeDb({ sequences: 3 })
    const stats = await loadEmailHubStats(db, LOC)

    const q = findQuery(db, 'email_sequences')
    expect(q.filters).toContainEqual(['status', 'active'])
    expect(q.filters.some(([col]) => col === 'active')).toBe(false)
    expect(stats.activeSequences).toBe(3)
  })

  it('scopes BOTH open-rate counts to the broadcast stream', async () => {
    const db = makeDb({ sent: 100, opened: 40 })
    await loadEmailHubStats(db, LOC)

    expect(findQuery(db, 'email_sends').filters).toContainEqual(['postmark_stream', 'broadcast'])
    expect(findQuery(db, 'email_sends', true).filters).toContainEqual(['postmark_stream', 'broadcast'])
  })

  it('still scopes every count to the location', async () => {
    const db = makeDb({ sent: 1, opened: 1, sequences: 1 })
    await loadEmailHubStats(db, LOC)

    for (const q of db.queries) expect(q.filters).toContainEqual(['location_id', LOC])
  })

  it('computes the open rate off the broadcast counts', async () => {
    const stats = await loadEmailHubStats(makeDb({ sent: 200, opened: 82 }), LOC)
    expect(stats.totalSent).toBe(200)
    expect(stats.totalOpened).toBe(82)
    expect(stats.openRate).toBe(41)
  })

  it('does not divide by zero when nothing has been broadcast yet', async () => {
    const stats = await loadEmailHubStats(makeDb({ sent: 0, opened: 0, sequences: 0 }), LOC)
    expect(stats.openRate).toBe(0)
  })
})
