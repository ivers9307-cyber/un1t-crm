import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { logError, logInfo } from '@/lib/log'
import { CLAIMED_ERROR_MARKER } from '@/lib/postmark-queue'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 120

/** Retention for a FINISHED webhook payload row. Richard's call, 5 Sep 2026. */
export const RETENTION_DAYS = 90
/**
 * Rows per page. The candidate read is `select id` only, so a page is a few
 * KB whatever the payloads weigh; 500 keeps each DELETE's `IN (…)` list short.
 */
export const PURGE_PAGE_SIZE = 500
/** Runaway guard — 10,000 rows per table per tick; the backlog drains daily. */
const MAX_PAGES = 20

/** The dead-letter statuses that mean "an operator is done with this row". */
export const FINISHED_DEAD_LETTER_STATUSES = ['resolved', 'discarded']

/** ISO cutoff: anything that finished before this is past retention. */
export function retentionCutoff(nowMs = Date.now()) {
  return new Date(nowMs - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString()
}

/**
 * GET /api/cron/purge-webhook-payloads — WEBHOOK-RETENTION.1.
 *
 * WHY. webhook_dead_letter.payload (mig 315) and postmark_webhook_queue.payload
 * (mig 158) hold the raw inbound-email JSON — sender, recipients, subject,
 * body — and nothing ever deleted a row from either table. A contact erased
 * under GDPR could therefore survive, address and all, in a resolved dead
 * letter or a processed queue row forever. This is the retention answer, NOT a
 * per-row scrub: a FINISHED row is deleted RETENTION_DAYS after it finished.
 * Pending, failed and unprocessed rows are the tables' live work and are never
 * touched, whatever their age.
 *
 * WHAT "FINISHED" MEANS, PER TABLE:
 *
 *   webhook_dead_letter — `status IN ('resolved','discarded')` AND
 *   `resolved_at < cutoff`. Every writer of those two statuses (the resolve
 *   route, bulk-resolve, replayDeadLetter on success) stamps resolved_at in
 *   the same UPDATE, so resolved_at IS the finished clock. A finished row with
 *   NO resolved_at (no code path writes one) is deliberately left alone rather
 *   than judged by received_at — the purge never guesses when a row finished.
 *   'pending' and 'failed' are the morgue's open work: never.
 *
 *   postmark_webhook_queue — the table has no status column; `processed_at`
 *   is its one completion mark, so `processed_at IS NOT NULL AND processed_at
 *   < cutoff`. Two rows wear a misleading shape and are excluded on purpose:
 *     • an EXHAUSTED row (POSTMARK-DLQ.1) — attempts >= MAX_ATTEMPTS with
 *       processed_at still NULL. Its payload was captured to webhook_dead_letter
 *       (provider postmark_queue), and THAT copy is purged 90 days after an
 *       operator resolves it; the queue row itself is unprocessed and stays.
 *     • a STALE CLAIM (POSTMARK-QUEUE-RECLAIM.1) — processed_at set by the
 *       claim CAS but `error` still carrying CLAIMED_ERROR_MARKER, i.e. the
 *       consumer died mid-flight. That is an UNFINISHED event; the reclaim
 *       sweep owns it. The guard is `error IS NULL OR error <> marker`, spelled
 *       as one .or() — a bare `.neq('error', marker)` would be SQL's `<>`,
 *       which is NULL for a NULL error, and a cleanly processed row's error IS
 *       NULL (the success path clears the marker): it would exclude exactly
 *       the rows this cron exists to delete.
 *
 * PAGING: delete-as-you-go. Each iteration reads the OLDEST PURGE_PAGE_SIZE
 * candidate ids with .range(0, n-1) ordered by the table's finished clock;
 * after that page is deleted the next oldest rows move into range 0, so the
 * cursor never advances and never skips. A short page ends the table;
 * MAX_PAGES bounds it. Every .select() caps at 1,000 rows whatever the code
 * asks for, so the read is always ranged. The finished predicate rides along
 * on EVERY delete as belt-and-braces: an id read a moment ago whose row has
 * since been reopened no longer matches and survives.
 *
 * FAILURE IS COLLECTED PER TABLE. A broken read or delete on one table does
 * not stop the other — a GDPR purge that stalls on one table for a schema
 * hiccup on the other is two problems instead of one. The run then answers
 * 500 with each table's error and does NOT stamp: a purge that is silently not
 * purging would show up only as a table that keeps growing. Idle runs (nothing
 * past retention) DO stamp: the cron ran and was right to do nothing.
 *
 * Secured by CRON_SECRET (Vercel cron sends Authorization: Bearer <secret>).
 * Heartbeat row + partial indexes ship with mig 587; vercel.json 03:45 UTC.
 */
export async function GET(request) {
  const cronSecret = process.env.CRON_SECRET
  const authHeader = request.headers.get('authorization')
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }

  const db = createServerClient()
  const cutoff = retentionCutoff(Date.now())

  const tables = [
    {
      table: 'webhook_dead_letter',
      clock: 'resolved_at',
      finished: (q) => q.in('status', FINISHED_DEAD_LETTER_STATUSES).lt('resolved_at', cutoff),
    },
    {
      table: 'postmark_webhook_queue',
      clock: 'processed_at',
      finished: (q) => q
        .not('processed_at', 'is', null)
        .lt('processed_at', cutoff)
        .or(`error.is.null,error.neq.${CLAIMED_ERROR_MARKER}`),
    },
  ]

  const deleted = {}
  const pages = {}
  const capReached = {}
  const errors = {}

  for (const spec of tables) {
    const result = await purgeTable(db, spec)
    deleted[spec.table] = result.deleted
    pages[spec.table] = result.pages
    capReached[spec.table] = result.capReached
    if (result.error) errors[spec.table] = result.error
  }

  const outcome = { cutoff, retention_days: RETENTION_DAYS, deleted, pages, cap_reached: capReached }

  const failedTables = Object.keys(errors)
  if (failedTables.length > 0) {
    logError('cron.purge-webhook-payloads', 'run failed for one or more tables — not stamping', { ...outcome, errors })
    return NextResponse.json({
      success: false,
      error: `purge failed for: ${failedTables.join(', ')}`,
      data: { ...outcome, errors },
    }, { status: 500 })
  }

  logInfo('cron.purge-webhook-payloads', 'run complete', outcome)
  await stampHeartbeat('purge-webhook-payloads', outcome)
  return NextResponse.json({ success: true, data: outcome })
}

/**
 * Purge one table's finished rows past the cutoff, page by page. Never throws
 * on a PostgREST error — returns it so the caller can collect per table.
 *
 * @returns {Promise<{ deleted: number, pages: number, capReached: boolean, error: string|null }>}
 */
async function purgeTable(db, { table, clock, finished }) {
  let deleted = 0
  let pages = 0
  let capReached = false

  for (;;) {
    if (pages >= MAX_PAGES) { capReached = true; break }

    const { data: rows, error: scanErr } = await finished(db.from(table).select('id'))
      .order(clock, { ascending: true })
      .range(0, PURGE_PAGE_SIZE - 1)
    if (scanErr) {
      logError('cron.purge-webhook-payloads', 'candidate scan failed', { table, err: scanErr.message, page: pages })
      return { deleted, pages, capReached, error: scanErr.message }
    }
    const ids = (rows || []).map(r => r?.id).filter(id => id !== null && id !== undefined)
    if (ids.length === 0) break
    pages += 1

    // `.select('id')` so the count is rows REMOVED, not rows requested: the
    // delete re-applies the finished predicate, so a row reopened between the
    // scan and this statement survives and must not be counted — and a delete
    // that removes nothing ends the loop instead of re-reading the same page
    // MAX_PAGES times and reporting deletions that never happened (review nit).
    const { data: gone, error: delErr } = await finished(db.from(table).delete()).in('id', ids).select('id')
    if (delErr) {
      logError('cron.purge-webhook-payloads', 'delete failed', { table, err: delErr.message, page: pages })
      return { deleted, pages, capReached, error: delErr.message }
    }
    const removed = Array.isArray(gone) ? gone.length : 0
    deleted += removed
    if (removed === 0) break

    if (ids.length < PURGE_PAGE_SIZE) break
  }

  return { deleted, pages, capReached, error: null }
}
