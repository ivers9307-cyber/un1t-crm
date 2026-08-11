// COMMS-DETAIL-FIX.1 — whatsapp_broadcast_recipients is the single DISPLAYED
// source for a WhatsApp broadcast's results, exactly as REPORT-SOT.2 made
// campaign_recipients the source for email (see campaign-display-stats.js —
// this module deliberately copies its shape rather than inventing a second
// idiom: a load* function that answers { ok, counts, error }, and a pure
// *DisplayStats that turns the row plus that answer into the figures a surface
// renders, always knowing which source produced them).
//
// THE PROBLEM. The results panel rendered SENT / DELIVERED / READ / FAILED
// from whatsapp_broadcasts.total_*, while the failed-sends box immediately
// below it counted recipient rows live. On screen that produced
//
//     FAILED  0        …directly above…      Failed sends (22)
//
// The stored counters really are stale. Measured live 2026-08-10:
//
//   broadcast                        stored recips/sent/delivered/failed   live rows
//   Consultation jun 28th (cancelled)   3,108 / 976 / 969 / 170              1,146
//   WhatsApp — 30 Jun (sent)               12 /  12 /  12 /   0     12 rows, 2 delivered
//
// ⚠️ THE STORED COUNTERS ARE NOT BEING REPAIRED AND NOT BEING DROPPED — the
// same explicit posture as the email side. Nothing here writes.
// increment_whatsapp_broadcast_metric keeps running unchanged.
//
// ── TRAP 1: THE STATUS COLUMN PROGRESSES ──────────────────────────────────
// whatsapp_broadcast_recipients.status (mig 007: pending, sent, delivered,
// read, failed; plus 'capped' from the drip's Meta-frequency-cap park) is a
// SINGLE column the webhook overwrites in place — `recipUpdates = { status }`
// in /api/webhooks/whatsapp. A row that was delivered no longer reads 'sent';
// one that was read no longer reads 'delivered'. So `count(status='sent')`
// returns 0 on a fully-delivered broadcast, which is a worse number than the
// stale counter it replaced.
//
// "Sent" therefore means REACHED AT LEAST sent, and "delivered" means REACHED
// AT LEAST delivered — the same monotonic reading the drip progress block in
// the detail page has always used. BACKLOG-6 hit this exact class on email.
//
// ── TRAP 2: A CANCELLED BROADCAST HAS TWO TRUE TOTALS ─────────────────────
// On the cancelled drip, stored total_recipients = 3,108 and live rows =
// 1,146, and BOTH are correct: 3,108 is the audience the send was aimed at
// (written when the send started), 1,146 is how many recipient rows had
// actually been created before it stopped. Neither is a correction of the
// other, so this module keeps them as two separately named figures —
// `audience` and `queued` — and the surface states the shortfall in words
// instead of quietly swapping one number for the other.

const num = (v) => Number(v || 0)

/**
 * Reached at least 'sent'. The status column moves forward in place, so a
 * delivered or read row was necessarily sent first.
 */
export const WA_REACHED_SENT = Object.freeze(['sent', 'delivered', 'read'])

/** Reached at least 'delivered'. A read message was necessarily delivered. */
export const WA_REACHED_DELIVERED = Object.freeze(['delivered', 'read'])

// ── TRAP 3: 'capped' IS NEITHER SENT NOR FAILED, AND NOTHING SAID SO ───────
// Meta 131049 is the recipient's CROSS-BUSINESS marketing frequency cap:
// temporary saturation of a perfectly good number, not a bad one.
// classifyBlastFailure (whatsapp.js) parks those rows as 'capped', keeps them
// out of the circuit breaker, and fetchDripDoneContactIds re-opens them for a
// retry after CAPPED_RETRY_HOURS. Counting a park as an outcome would be the
// bug; it is deliberately in neither WA_REACHED_SENT nor the failed count.
//
// The consequence is arithmetic the panel never explained: mid-cap,
// sent + failed is SHORT of the queued row count, and the four cards look like
// they have lost people. So the count is surfaced as its own figure and the
// surface states it in words. Nothing is reclassified.
//
// Exact match, not a reached-at-least set: 'capped' is a park beside the
// progression, not a stage along it. A row that later succeeds is overwritten
// with 'sent' and stops being capped, which is the correct reading — the park
// is over.

/**
 * Count one broadcast's recipient rows by how far each one got.
 *
 * Count-only (`head: true`) on every query: a drip can carry thousands of
 * recipient rows, the 1,000-row select cap would silently truncate a fetch,
 * and nothing here needs the rows themselves. Six parallel counts is one
 * round trip's worth of latency and needs no migration — which matters,
 * because an aggregate rpc could not ship ahead of being applied.
 *
 * @param {object} db  service-role supabase client
 * @param {string} broadcastId  already resolved through assertLocationAccess
 *                              by the caller (this applies no tenant filter)
 * @returns {Promise<{ ok: boolean, counts: object|null, error: string|null }>}
 */
export async function loadWhatsappBroadcastRecipientStats(db, broadcastId) {
  if (!broadcastId) return { ok: false, counts: null, error: 'no broadcast id' }

  const countRows = async (apply) => {
    // supabase-js builders are thenables, not Promises — no .catch to hang
    // off, so the try/catch wraps the await (see CLAUDE.md).
    const { count, error } = await apply(
      db.from('whatsapp_broadcast_recipients')
        .select('id', { count: 'exact', head: true })
        .eq('broadcast_id', broadcastId)
    )
    if (error) throw new Error(error.message)
    return count || 0
  }

  try {
    const [rows, sent, delivered, read, failed, capped] = await Promise.all([
      countRows(q => q),
      countRows(q => q.in('status', WA_REACHED_SENT)),
      countRows(q => q.in('status', WA_REACHED_DELIVERED)),
      countRows(q => q.eq('status', 'read')),
      countRows(q => q.eq('status', 'failed')),
      countRows(q => q.eq('status', 'capped')),
    ])
    return { ok: true, counts: { rows, sent, delivered, read, failed, capped }, error: null }
  } catch (e) {
    console.error('[wa broadcast stats] recipient counts failed:', e?.message || e)
    return { ok: false, counts: null, error: e?.message || 'recipient counts failed' }
  }
}

/**
 * Count rows dispatched inside the last 24h — the drip's rolling cap usage.
 * Kept beside the counts above so the drip panel and the results panel share
 * one status vocabulary. Best-effort: a failure reads as 0, never throws.
 */
export async function countWhatsappSentToday(db, broadcastId, now = new Date()) {
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString()
  try {
    const { count } = await db.from('whatsapp_broadcast_recipients')
      .select('id', { count: 'exact', head: true })
      .eq('broadcast_id', broadcastId)
      .in('status', WA_REACHED_SENT)
      .gt('sent_at', since)
    return count || 0
  } catch {
    return 0
  }
}

/**
 * The figures a WhatsApp send-detail surface renders.
 *
 * @param {object} broadcast  the whatsapp_broadcasts row (counters fallback)
 * @param {object|null} stats  the result of loadWhatsappBroadcastRecipientStats
 */
export function whatsappBroadcastDisplayStats(broadcast, stats) {
  const b = broadcast || {}
  const live = !!(stats && stats.ok && stats.counts)

  const c = live ? stats.counts : {
    // The counters, read exactly as the panel read them before this change,
    // so a fallback render is the old behaviour and not a third answer.
    rows: num(b.total_recipients),
    sent: num(b.total_sent),
    delivered: num(b.total_delivered),
    read: num(b.total_read),
    failed: num(b.total_failed),
    // The stored counters have no capped column at all, so a fallback render
    // cannot know. Zero here means "not measured", and `unaccounted` below is
    // held at zero too rather than inventing a shortfall out of counters that
    // are already known to lag.
    capped: 0,
  }

  const audience = num(b.total_recipients)
  const queued = num(c.rows)
  // Only meaningful against a live row count. On the counters fallback both
  // numbers ARE total_recipients, so the shortfall is unknown, not zero — and
  // claiming a broadcast stopped short on the strength of a figure we did not
  // measure is the same class of lie this module exists to remove.
  const neverQueued = live ? Math.max(0, audience - queued) : 0

  return {
    source: live ? 'recipients' : 'counters',
    // The audience the send was aimed at, recorded when it started.
    audience,
    // How many recipient rows actually exist. Equal to `audience` on a send
    // that ran to completion; smaller on one that was cancelled part-way.
    queued,
    neverQueued,
    // A cancelled broadcast that never queued its whole audience. Says
    // "it stopped short", never "the stored number was wrong".
    stoppedShort: live && b.status === 'cancelled' && neverQueued > 0,
    sent: num(c.sent),
    delivered: num(c.delivered),
    read: num(c.read),
    failed: num(c.failed),
    // Parked by Meta's frequency cap: neither sent nor failed, retried later.
    capped: num(c.capped),
    // Queued rows that Sent, Failed and the capped park between them still do
    // not name: 'pending' rows the drip has not reached yet, plus any status a
    // later migration adds that this module has not been taught. Named here
    // rather than re-derived at each surface so the results panel and the drip
    // block cannot disagree about it.
    unaccounted: live
      ? Math.max(0, num(c.rows) - num(c.sent) - num(c.failed) - num(c.capped))
      : 0,
  }
}
