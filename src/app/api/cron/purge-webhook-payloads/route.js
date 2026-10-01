import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { logError, logInfo, logWarn } from '@/lib/log'
import { CLAIMED_ERROR_MARKER, EXHAUSTED_PROVIDER, MAX_ATTEMPTS } from '@/lib/postmark-queue'
import { escapeLikePattern } from '@/lib/like-escape'

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

/**
 * The error text captureExhaustedRow (src/lib/postmark-queue.js) writes on an
 * exhausted row's dead-letter twin: `postmark_webhook_queue row <id> exhausted
 * after <n> attempts: <error>`. The twin check matches this prefix, so a
 * change to that text must change this too (the route test pins both).
 */
export function exhaustedTwinErrorPrefix(queueRowId) {
  return `postmark_webhook_queue row ${queueRowId} exhausted after `
}

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
 *   < cutoff`. An EXHAUSTED row has its own spec (next paragraph). A STALE
 *   CLAIM wears a misleading shape and is excluded on purpose:
 *     • a STALE CLAIM (POSTMARK-QUEUE-RECLAIM.1) — processed_at set by the
 *       claim CAS but `error` still carrying CLAIMED_ERROR_MARKER, i.e. the
 *       consumer died mid-flight. That is an UNFINISHED event; the reclaim
 *       sweep owns it. The guard is `error IS NULL OR error <> marker`, spelled
 *       as one .or() — a bare `.neq('error', marker)` would be SQL's `<>`,
 *       which is NULL for a NULL error, and a cleanly processed row's error IS
 *       NULL (the success path clears the marker): it would exclude exactly
 *       the rows this cron exists to delete.
 *
 *   postmark_webhook_queue, EXHAUSTED (PURGEEXHAUSTED.1 — Richard's 5 Sep
 *   decision, "exhausted queue rows purge too", which reached the heartbeat
 *   notes but not this file until now) — `processed_at IS NULL AND attempts
 *   >= MAX_ATTEMPTS AND received_at < cutoff`. Such a row was never processed,
 *   so it has no finished clock; received_at is its clock, and nothing will
 *   ever retry it (both consumers select `attempts < MAX_ATTEMPTS`). Its
 *   payload lives on in the dead-letter twin captureExhaustedRow wrote at
 *   exhaustion (provider EXHAUSTED_PROVIDER, error text naming this row's id),
 *   which is purged on its own schedule, 90 days after an operator resolves
 *   it. The twin is CHECKED before a row goes: if the capture failed (it is
 *   best-effort) or the row predates POSTMARK-DLQ.1, the queue row is the
 *   event's ONLY copy (a bounce or an unsubscribe nobody has handled), so it
 *   is kept, counted in `kept_no_twin` and logged, never destroyed. This spec
 *   runs BEFORE the dead-letter spec: a twin old enough to be purged was
 *   resolved after its queue row was received, so the queue row is already
 *   past the cutoff and goes in the same run rather than losing its twin
 *   first and being stranded (only a MAX_PAGES cap on this spec can leave
 *   one; it is kept, which errs toward retention, not loss).
 *
 *   glofox_webhook_attempts (WEBHOOKAUDIT.1, mig 649) — one PII-free row per
 *   processed Glofox webhook delivery, written after processing, so every row
 *   is finished: `processed_at < cutoff`, nothing else. (glofox_webhook_events
 *   itself is NOT purged here: /api/cron/purge-glofox-webhook-events does it,
 *   C47 GLOFOXEVENTRETENTION.1, mig 694.)
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
      // PURGEEXHAUSTED.1 — first, see the header.
      name: 'postmark_webhook_queue_exhausted',
      purge: () => purgeExhaustedQueueRows(db, cutoff),
    },
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
    {
      // WEBHOOKAUDIT.1 (mig 649). One row per processed Glofox delivery,
      // written AFTER processing, so every row is finished when written:
      // processed_at (NOT NULL) is the only clock and there is no open work.
      table: 'glofox_webhook_attempts',
      clock: 'processed_at',
      finished: (q) => q.lt('processed_at', cutoff),
    },
  ]

  const deleted = {}
  const pages = {}
  const capReached = {}
  const errors = {}
  let keptNoTwin = 0

  for (const spec of tables) {
    const name = spec.name || spec.table
    const result = spec.purge ? await spec.purge() : await purgeTable(db, spec)
    deleted[name] = result.deleted
    pages[name] = result.pages
    capReached[name] = result.capReached
    if (result.keptNoTwin) keptNoTwin += result.keptNoTwin
    if (result.error) errors[name] = result.error
  }

  const outcome = { cutoff, retention_days: RETENTION_DAYS, deleted, pages, cap_reached: capReached, kept_no_twin: keptNoTwin }

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

/**
 * PURGEEXHAUSTED.1 — purge exhausted queue rows past the cutoff whose
 * dead-letter twin exists. Never throws on a PostgREST error — returns it.
 *
 * Paging: rows with no twin stay in the candidate set, so the read skips
 * past them by offset (`kept`) instead of re-reading the same head page;
 * deleted rows leave the set, so the offset never skips a live candidate.
 * Ordered by received_at then id, so the offset is deterministic.
 *
 * @returns {Promise<{ deleted: number, pages: number, capReached: boolean, keptNoTwin: number, error: string|null }>}
 */
async function purgeExhaustedQueueRows(db, cutoff) {
  const exhausted = (q) => q
    .is('processed_at', null)
    .gte('attempts', MAX_ATTEMPTS)
    .lt('received_at', cutoff)
  let deleted = 0
  let pages = 0
  let capReached = false
  let kept = 0
  const done = (error = null) => {
    if (kept > 0) {
      logWarn('cron.purge-webhook-payloads', 'exhausted queue rows kept: no dead-letter twin, the queue row is the only copy', { kept })
    }
    return { deleted, pages, capReached, keptNoTwin: kept, error }
  }

  for (;;) {
    if (pages >= MAX_PAGES) { capReached = true; break }

    const { data: rows, error: scanErr } = await exhausted(db.from('postmark_webhook_queue').select('id'))
      .order('received_at', { ascending: true })
      .order('id', { ascending: true })
      .range(kept, kept + PURGE_PAGE_SIZE - 1)
    if (scanErr) {
      logError('cron.purge-webhook-payloads', 'exhausted candidate scan failed', { err: scanErr.message, page: pages })
      return done(scanErr.message)
    }
    const ids = (rows || []).map(r => r?.id).filter(id => id !== null && id !== undefined)
    if (ids.length === 0) break
    pages += 1

    const withTwin = []
    for (const id of ids) {
      const { data: twins, error: twinErr } = await db.from('webhook_dead_letter')
        .select('id')
        .eq('provider', EXHAUSTED_PROVIDER)
        .ilike('error', `${escapeLikePattern(exhaustedTwinErrorPrefix(id))}%`)
        .limit(1)
      if (twinErr) {
        // Cannot prove the payload survives: purge nothing more this run.
        logError('cron.purge-webhook-payloads', 'dead-letter twin read failed', { err: twinErr.message, page: pages })
        return done(twinErr.message)
      }
      if (Array.isArray(twins) && twins.length > 0) withTwin.push(id)
      else kept += 1
    }

    if (withTwin.length > 0) {
      // The exhausted predicate rides along: a row re-queued since the scan
      // (an operator re-drive resets attempts) no longer matches and survives.
      const { data: gone, error: delErr } = await exhausted(db.from('postmark_webhook_queue').delete())
        .in('id', withTwin)
        .select('id')
      if (delErr) {
        logError('cron.purge-webhook-payloads', 'exhausted delete failed', { err: delErr.message, page: pages })
        return done(delErr.message)
      }
      deleted += Array.isArray(gone) ? gone.length : 0
    }

    if (ids.length < PURGE_PAGE_SIZE) break
  }

  return done()
}
