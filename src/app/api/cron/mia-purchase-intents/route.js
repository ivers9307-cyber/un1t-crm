// MIAHATCH.6 (Task 23) — the third settle detector: every 5 minutes, settle
// paid Mia payment links from the un1t mirror (zero un1t.online calls; the
// un1t-online-sync cron keeps the mirror fresh and is fenced from the write
// side, so the watcher runs here and not as a post-sync hook). Mirror of the
// spec's 6.5 fallback; src/lib/agent/purchase-settle.js does the work.
//
// Each run, in order, each step isolated (one item throwing never stops the
// rest; failures are counted):
//   1. every live intent (link_sent) -> settlePurchaseIntent(watcher, mirror);
//   2. an intent left in 'paid' for over 10 minutes (a settle killed mid-way)
//      -> markStuckPaidIntent: closed book_failed with ONE staff card, never
//      rebooked, nothing sent;
//   3. intents settled (booked, book_failed, no_class) in the last 24 h -> the
//      winner's double-payment check again, on the same window (a second
//      purchase of the product up to 60 min after the payment, never past
//      expiry; a second payment the mirror shows only later), one record-only
//      card per intent;
//   4. the silent expiry sweep (expireStaleIntents).
// Off until intents exist: an empty run is four cheap reads.
//
// Heartbeat 'mia-purchase-intents' (mig 755, 300 + 600). Stamped when the run
// completed, with counts only (no ids, no PII); a run with nothing to do is
// healthy. Per-intent failures are counts, never a missed stamp. A step that
// could not read its list (or an expiry sweep that failed) means the run did
// not do its job: every other step still runs, the answer is a 500 with the
// counts and the row is left to go stale, so a fault lasting past one missed
// tick pages.
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { logError } from '@/lib/log'
import {
  RECHECK_STATUSES, expireStaleIntents, markStuckPaidIntent, recheckDoublePayment, settlePurchaseIntent,
} from '@/lib/agent/purchase-settle'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const HEARTBEAT = 'mia-purchase-intents'
const LOG_MODULE = 'mia-un1t'
const INTENTS = 'mia_purchase_intents'
/** Rows per page of each list (under the 1,000-row select cap). */
const PAGE = 500
const STUCK_AFTER_MS = 10 * 60_000
const RECHECK_WINDOW_MS = 24 * 60 * 60_000

/**
 * Every intent id one filter matches, keyset-paged on id (an explicit order;
 * a row that leaves the filter mid-run never shifts a page). { ids } or
 * { ids, failed: true } when a page could not be read.
 */
async function listIntentIds(db, op, filter) {
  const ids = []
  let after = null
  try {
    for (;;) {
      let q = filter(db.from(INTENTS).select('id'))
      if (after) q = q.gt('id', after)
      const { data, error } = await q.order('id', { ascending: true }).range(0, PAGE - 1)
      if (error) {
        logError(LOG_MODULE, 'watcher list unreadable', { op, status: null, code: error.code ?? null, read: ids.length })
        return { ids, failed: true }
      }
      const rows = (Array.isArray(data) ? data : []).map((r) => r?.id).filter(Boolean)
      ids.push(...rows)
      if (rows.length < PAGE) return { ids }
      after = rows[rows.length - 1]
    }
  } catch (err) {
    logError(LOG_MODULE, 'watcher list threw', { op, status: null, errClass: err?.name ?? null, read: ids.length })
    return { ids, failed: true }
  }
}

/** Run `work` per id; a throw is logged (code only) and counted, never stops the rest. */
async function eachIsolated(ids, op, work, counts) {
  for (const id of ids) {
    try {
      await work(id)
    } catch (err) {
      counts.errors += 1
      logError(LOG_MODULE, 'watcher item threw', { op, intentId: id, status: null, errClass: err?.name ?? null })
    }
  }
}

async function runWatcher(db, now) {
  const counts = { settled: {}, stuck_marked: 0, double_payment_cards: 0, expired: 0, errors: 0 }
  let complete = true
  const list = async (op, filter) => {
    const r = await listIntentIds(db, op, filter)
    if (r.failed) { counts.errors += 1; complete = false }
    return r.ids
  }

  // 1. Settle every live intent from the mirror.
  const live = await list('watcher_live', (q) => q.eq('status', 'link_sent'))
  await eachIsolated(live, 'watcher_settle', async (id) => {
    const { outcome } = await settlePurchaseIntent(db, id, { detectedBy: 'watcher', source: 'mirror', now: () => now })
    const key = typeof outcome === 'string' ? outcome : 'unknown'
    counts.settled[key] = (counts.settled[key] || 0) + 1
    if (outcome === 'error') counts.errors += 1
  }, counts)

  // 2. Close an intent stuck in 'paid' (never rebooked, nothing sent).
  const stuckBefore = new Date(now - STUCK_AFTER_MS).toISOString()
  const stuck = await list('watcher_stuck', (q) => q.eq('status', 'paid').lt('paid_detected_at', stuckBefore))
  await eachIsolated(stuck, 'watcher_stuck', async (id) => {
    const { marked } = await markStuckPaidIntent(db, id, { code: 'watcher_stuck_paid', now })
    if (marked) counts.stuck_marked += 1
  }, counts)

  // 3. A double payment the mirror shows only after the settle.
  const settledSince = new Date(now - RECHECK_WINDOW_MS).toISOString()
  const recent = await list('watcher_double', (q) => q.in('status', [...RECHECK_STATUSES]).gte('paid_detected_at', settledSince))
  await eachIsolated(recent, 'watcher_double', async (id) => {
    const { filed } = await recheckDoublePayment(db, id, { now })
    if (filed) counts.double_payment_cards += 1
  }, counts)

  // 4. The silent expiry sweep (never throws).
  try {
    const swept = await expireStaleIntents(db, { now })
    counts.expired = Number(swept?.expired) || 0
    if (swept?.error) { counts.errors += 1; complete = false }
  } catch (err) {
    counts.errors += 1
    complete = false
    logError(LOG_MODULE, 'watcher expiry threw', { op: 'watcher_expire', status: null, errClass: err?.name ?? null })
  }

  return { counts, complete }
}

export async function GET(request) {
  const auth = request.headers.get('authorization') || ''
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }

  const db = createServerClient()
  const { counts, complete } = await runWatcher(db, Date.now())
  if (!complete) {
    return NextResponse.json({ success: false, error: 'Watcher run incomplete', data: counts }, { status: 500 })
  }
  await stampHeartbeat(HEARTBEAT, counts)
  return NextResponse.json({ success: true, data: counts })
}
