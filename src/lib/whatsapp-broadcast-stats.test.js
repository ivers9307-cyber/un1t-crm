// COMMS-DETAIL-FIX.1 — the WhatsApp results panel must not contradict itself.
//
// The stat cards read whatsapp_broadcasts.total_*; the failed-sends box beside
// them counted whatsapp_broadcast_recipients live. On a real broadcast that
// produced "FAILED 0" directly above "Failed sends (22)".
//
// Two traps these tests pin down:
//
//  1. whatsapp_broadcast_recipients.status PROGRESSES in place (mig 007 +
//     the webhook's single-column update): a delivered row no longer reads
//     'sent', a read row no longer reads 'delivered'. So counting
//     status='sent' returns 0 on a fully-delivered broadcast. "Sent" means
//     reached AT LEAST sent; "delivered" means reached AT LEAST delivered.
//
//  2. On a CANCELLED broadcast the stored total_recipients (the audience the
//     send was aimed at) and the live recipient-row count (how many were
//     actually queued before it stopped) are BOTH true. Neither corrects the
//     other, and the display object keeps them as separate named figures.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  WA_REACHED_SENT,
  WA_REACHED_DELIVERED,
  loadWhatsappBroadcastRecipientStats,
  whatsappBroadcastDisplayStats,
} from './whatsapp-broadcast-stats.js'

// A recording stand-in for the supabase count-only builder. Every chained
// call is captured so the tests can assert WHICH statuses were counted, and
// awaiting the chain yields the seeded count for the recorded predicate.
function countingDb(resolve) {
  const calls = []
  const db = {
    from(table) {
      const call = { table, filters: [] }
      calls.push(call)
      const chain = new Proxy({}, {
        get(_t, prop) {
          if (prop === 'then') {
            return (res) => res(resolve(call))
          }
          return (...args) => { call.filters.push([prop, ...args]); return chain }
        },
      })
      return chain
    },
  }
  return { db, calls }
}

// A broadcast whose recipient rows have all moved past 'sent'.
const FULLY_DELIVERED = (call) => {
  const inFilter = call.filters.find(f => f[0] === 'in')
  const eqStatus = call.filters.find(f => f[0] === 'eq' && f[1] === 'status')
  if (inFilter) {
    const statuses = inFilter[2]
    // 12 rows: 2 delivered, 10 read. Nothing is sitting at 'sent'.
    const bucket = { sent: 0, delivered: 2, read: 10 }
    return { count: statuses.reduce((n, s) => n + (bucket[s] || 0), 0), error: null }
  }
  if (eqStatus) return { count: eqStatus[2] === 'read' ? 10 : 0, error: null }
  return { count: 12, error: null }
}

beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}) })
afterEach(() => { vi.restoreAllMocks() })

describe('WA recipient status progression', () => {
  it('counts "sent" as reached-at-least-sent, not status === sent', async () => {
    expect(WA_REACHED_SENT).toEqual(['sent', 'delivered', 'read'])
    const { db, calls } = countingDb(FULLY_DELIVERED)
    const stats = await loadWhatsappBroadcastRecipientStats(db, 'b1')

    expect(stats.ok).toBe(true)
    // Every row has progressed past 'sent', yet all 12 were sent.
    expect(stats.counts.sent).toBe(12)
    // The naive query is never issued.
    const naive = calls.some(c => c.filters.some(f => f[0] === 'eq' && f[1] === 'status' && f[2] === 'sent'))
    expect(naive).toBe(false)
  })

  it('counts "delivered" as reached-at-least-delivered', async () => {
    expect(WA_REACHED_DELIVERED).toEqual(['delivered', 'read'])
    const { db } = countingDb(FULLY_DELIVERED)
    const stats = await loadWhatsappBroadcastRecipientStats(db, 'b1')
    // 2 delivered + 10 read: a read message was necessarily delivered.
    expect(stats.counts.delivered).toBe(12)
    expect(stats.counts.read).toBe(10)
  })

  it('scopes every count to the one broadcast', async () => {
    const { db, calls } = countingDb(FULLY_DELIVERED)
    await loadWhatsappBroadcastRecipientStats(db, 'b1')
    expect(calls.length).toBeGreaterThan(0)
    for (const call of calls) {
      expect(call.table).toBe('whatsapp_broadcast_recipients')
      expect(call.filters).toContainEqual(['eq', 'broadcast_id', 'b1'])
      // Count-only: never pull rows back for a 3,000-recipient drip.
      expect(call.filters.some(f => f[0] === 'select' && f[2]?.head === true)).toBe(true)
    }
  })

  it('falls back rather than throwing when a count query errors', async () => {
    const { db } = countingDb(() => ({ count: null, error: { message: 'boom' } }))
    const stats = await loadWhatsappBroadcastRecipientStats(db, 'b1')
    expect(stats.ok).toBe(false)
    expect(stats.error).toMatch(/boom/)
  })
})

describe('whatsappBroadcastDisplayStats — one screen, one set of numbers', () => {
  // The live broadcast that produced "FAILED 0" above "Failed sends (22)".
  const STALE_COUNTERS = {
    id: 'b1', status: 'sent',
    total_recipients: 12, total_sent: 12, total_delivered: 12, total_read: 12, total_failed: 0,
  }

  it('prefers the live recipient counts over the stored counters', () => {
    const d = whatsappBroadcastDisplayStats(STALE_COUNTERS, {
      ok: true, counts: { rows: 12, sent: 12, delivered: 2, read: 0, failed: 22 }, error: null,
    })
    expect(d.source).toBe('recipients')
    expect(d.delivered).toBe(2)      // NOT the stored 12
    expect(d.failed).toBe(22)        // NOT the stored 0
  })

  it('falls back to the stored counters, and says so, when the counts failed', () => {
    const d = whatsappBroadcastDisplayStats(STALE_COUNTERS, { ok: false, counts: null, error: 'boom' })
    expect(d.source).toBe('counters')
    expect(d.delivered).toBe(12)
    expect(d.failed).toBe(0)
  })

  it('treats a missing stats argument as the counters fallback', () => {
    expect(whatsappBroadcastDisplayStats(STALE_COUNTERS, null).source).toBe('counters')
  })
})

describe('whatsappBroadcastDisplayStats — a cancelled broadcast', () => {
  // Measured live: stored 3,108 recipients / 976 sent / 969 delivered / 170
  // failed, against 1,146 recipient rows that actually exist.
  const CANCELLED = {
    id: 'b2', status: 'cancelled',
    total_recipients: 3108, total_sent: 976, total_delivered: 969, total_read: 400, total_failed: 170,
  }
  const LIVE = { ok: true, counts: { rows: 1146, sent: 976, delivered: 969, read: 400, failed: 170 }, error: null }

  it('keeps the audience and the queued count as two separate figures', () => {
    const d = whatsappBroadcastDisplayStats(CANCELLED, LIVE)
    // The audience the send was aimed at…
    expect(d.audience).toBe(3108)
    // …and how many were actually queued before it was cancelled. Both true.
    expect(d.queued).toBe(1146)
    expect(d.neverQueued).toBe(1962)
  })

  it('flags that it stopped short so the surface can say so out loud', () => {
    expect(whatsappBroadcastDisplayStats(CANCELLED, LIVE).stoppedShort).toBe(true)
  })

  it('does not claim a completed send stopped short', () => {
    const d = whatsappBroadcastDisplayStats(
      { id: 'b3', status: 'sent', total_recipients: 12 },
      { ok: true, counts: { rows: 12, sent: 12, delivered: 2, read: 0, failed: 0 }, error: null },
    )
    expect(d.stoppedShort).toBe(false)
    expect(d.neverQueued).toBe(0)
  })

  it('never claims it stopped short on the counters fallback (the queued figure is unknown there)', () => {
    const d = whatsappBroadcastDisplayStats(CANCELLED, { ok: false, counts: null, error: 'boom' })
    expect(d.stoppedShort).toBe(false)
  })
})

// ── WACAPPED.1 — the fifth status nobody counted ────────────────────────────
//
// A recipient parked by Meta's cross-business frequency cap (131049) is
// recorded 'capped': neither sent nor failed, and correctly so — it is a
// retryable park, not an outcome (classifyBlastFailure, whatsapp.js). But the
// four cards are counted from a status column that has five terminal-ish
// values, so mid-cap Sent + Failed is short of the queued total and no surface
// says why. The arithmetic is right; the explanation was missing.
describe('whatsappBroadcastDisplayStats — the capped park', () => {
  const DRIP = { id: 'b4', status: 'sending', total_recipients: 100 }
  const live = (counts) => ({ ok: true, counts: { rows: 100, sent: 0, delivered: 0, read: 0, failed: 0, capped: 0, ...counts }, error: null })

  it('carries the capped count through as its own figure', () => {
    const d = whatsappBroadcastDisplayStats(DRIP, live({ sent: 60, delivered: 55, read: 10, failed: 5, capped: 12 }))
    expect(d.capped).toBe(12)
  })

  it('never reclassifies a capped row as sent or failed', () => {
    const d = whatsappBroadcastDisplayStats(DRIP, live({ sent: 60, failed: 5, capped: 12 }))
    expect(d.sent).toBe(60)
    expect(d.failed).toBe(5)
  })

  it('reports the shortfall the four cards leave against the queued total', () => {
    // 100 queued, 60 sent, 5 failed, 12 capped → 23 not yet attempted.
    const d = whatsappBroadcastDisplayStats(DRIP, live({ sent: 60, failed: 5, capped: 12 }))
    expect(d.unaccounted).toBe(23)
  })

  it('reads a missing capped count as zero rather than NaN', () => {
    const d = whatsappBroadcastDisplayStats(DRIP, { ok: true, counts: { rows: 12, sent: 12, delivered: 2, read: 0, failed: 0 }, error: null })
    expect(d.capped).toBe(0)
    expect(d.unaccounted).toBe(0)
  })

  it('claims no capped rows on the counters fallback, which cannot know', () => {
    // The stored counters have no capped column at all, so a number here would
    // be invented — the same rule neverQueued already follows.
    const d = whatsappBroadcastDisplayStats(
      { id: 'b5', status: 'sent', total_recipients: 50, total_sent: 40, total_failed: 2 },
      { ok: false, counts: null, error: 'boom' },
    )
    expect(d.capped).toBe(0)
    expect(d.unaccounted).toBe(0)
  })
})

describe('loadWhatsappBroadcastRecipientStats — counting capped', () => {
  it('counts capped rows with an exact-status match, not a reached-at-least set', () => {
    // 'capped' is a park, not a stage on the way to delivered, so it takes the
    // same .eq treatment as 'failed'.
    const applied = []
    const q = {
      eq: (...a) => { applied.push(['eq', ...a]); return q },
      in: (...a) => { applied.push(['in', ...a]); return q },
      select: () => q,
      then: (res) => Promise.resolve({ count: 0, error: null }).then(res),
    }
    const db = { from: () => q }
    return loadWhatsappBroadcastRecipientStats(db, 'b1').then((out) => {
      expect(out.ok).toBe(true)
      expect(out.counts.capped).toBe(0)
      expect(applied).toContainEqual(['eq', 'status', 'capped'])
    })
  })
})
