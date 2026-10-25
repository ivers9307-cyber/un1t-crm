import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { logError, logInfo } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 120

/** Retention for a glofox_webhook_events row. Richard's call, 1 Oct 2026 (C47). */
export const RETENTION_DAYS = 90
/**
 * Ids per page, and so per DELETE. The ids are uuids, so 200 keeps each
 * `.in()` list (about 7.5 KB of URL) well inside what PostgREST accepts.
 */
export const PURGE_PAGE_SIZE = 200
/** Pages per run: at most 1,000 rows a day. The backlog drains over a few runs. */
const MAX_PAGES = 5
export const MAX_ROWS_PER_RUN = PURGE_PAGE_SIZE * MAX_PAGES
/** The cron_heartbeats row (mig 694). */
export const HEARTBEAT_NAME = 'purge-glofox-webhook-events'
/** PostgREST returns at most 1,000 rows per read; the attempt guard pages at that. */
const GUARD_PAGE_SIZE = 1000

/** ISO cutoff: a row with no activity since this is past retention. */
export function retentionCutoff(nowMs = Date.now()) {
  return new Date(nowMs - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString()
}

/**
 * GET /api/cron/purge-glofox-webhook-events — GLOFOXEVENTRETENTION.1 (C47).
 *
 * WHY. glofox_webhook_events (mig 132) keeps every Glofox webhook's payload and
 * its processing result, and `result.member_sync` carries the member's name,
 * email, phone, date of birth and emergency contact. Nothing ever deleted a
 * row (about 16k rows since 12 May 2026, 67 MB on 2 Oct). Richard's decision
 * (1 Oct 2026): purge rows older than 90 days, daily. It is mig 587's policy
 * (/api/cron/purge-webhook-payloads), with its own route and heartbeat.
 *
 * WHAT "OLDER THAN 90 DAYS" MEANS. A row is one Glofox ENTITY (event_id is
 * Payload.id; see the mig 649 comment), not one delivery. received_at is when
 * the entity was FIRST seen: the ingest upsert never rewrites it. processed_at
 * is when its LATEST event was processed: markEvent rewrites it every time.
 * So the row is past retention only when BOTH are past the cutoff (or
 * processed_at is NULL: never processed). A member first seen in May whose
 * latest MEMBER_UPDATED was processed yesterday holds yesterday's data, which
 * is inside retention, so it stays.
 *
 * THE CASCADE. glofox_webhook_attempts.event_row_id is ON DELETE CASCADE
 * (mig 649), so deleting an event row deletes its delivery history. The
 * attempts table has its own 90-day purge, and C46 (GLOFOXDEDUP.1) reads a
 * week or so of it. A delivery that throws records an attempt WITHOUT
 * touching the event row's processed_at, so the timestamps alone cannot prove
 * a row has no recent history: before each DELETE the page's ids are checked
 * against glofox_webhook_attempts, and a row with any attempt processed on or
 * after the cutoff is kept (counted in kept_recent_attempts). So the purge
 * never removes an attempt row younger than 90 days.
 *
 * WHO ELSE READS THE TABLE (checked 2 Oct): only /api/webhooks/glofox, which
 * upserts by event_id; a purged entity's next event simply inserts a fresh
 * row. No function, view or trigger names the table; un1t-sentinel,
 * un1t-platform, champ-app and champ-bridge do not read it.
 *
 * ACCEPTED RACE. A delivery for an entity idle for 90 days that lands in the
 * same moment as its row's DELETE can lose its audit writes (the event-row
 * UPDATE matches nothing; the attempt INSERT fails its FK and is logged). Its
 * processing and side effects are unaffected; the route still answers 200.
 *
 * BATCHED. Each page reads the OLDEST PURGE_PAGE_SIZE candidate ids (`select
 * id`, ordered by received_at then id). Deleted rows leave the candidate set;
 * kept rows stay, so the read skips past them by offset. MAX_PAGES caps a run
 * at MAX_ROWS_PER_RUN rows; the rest goes on the next day's run. Each DELETE
 * names its ids and re-applies the retention predicate, so a row that became
 * active between the read and the delete survives, and `.select('id')` counts
 * the rows actually removed.
 *
 * FAIL CLOSED. A failed read (candidates or the attempt guard) or a failed
 * delete stops the run: nothing more is deleted, the route answers 500, and
 * the heartbeat is NOT stamped, so a purge that has stopped purging pages.
 * A run with nothing to delete, or one that hit the cap, stamps.
 *
 * Secured by CRON_SECRET. Heartbeat row: mig 694. vercel.json: daily 04:05 UTC.
 */
export async function GET(request) {
  const cronSecret = process.env.CRON_SECRET
  const authHeader = request.headers.get('authorization')
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }

  const db = createServerClient()
  const cutoff = retentionCutoff(Date.now())
  const pastRetention = (q) => q
    .lt('received_at', cutoff)
    .or(`processed_at.is.null,processed_at.lt.${cutoff}`)

  let deleted = 0
  let pages = 0
  let kept = 0
  let capReached = false
  let failure = null

  for (;;) {
    if (pages >= MAX_PAGES) { capReached = true; break }

    const { data: rows, error: scanErr } = await pastRetention(db.from('glofox_webhook_events').select('id'))
      .order('received_at', { ascending: true })
      .order('id', { ascending: true })
      .range(kept, kept + PURGE_PAGE_SIZE - 1)
    if (scanErr) { failure = { step: 'candidate read', message: scanErr.message }; break }
    const ids = (rows || []).map((r) => r?.id).filter(Boolean)
    if (ids.length === 0) break
    pages += 1

    const guard = await idsWithRecentAttempts(db, ids, cutoff)
    if (guard.error) { failure = { step: 'attempt guard read', message: guard.error }; break }
    const deletable = ids.filter((id) => !guard.ids.has(id))
    kept += ids.length - deletable.length

    if (deletable.length > 0) {
      const { data: gone, error: delErr } = await pastRetention(db.from('glofox_webhook_events').delete())
        .in('id', deletable)
        .select('id')
      if (delErr) { failure = { step: 'delete', message: delErr.message }; break }
      deleted += Array.isArray(gone) ? gone.length : 0
    }

    if (ids.length < PURGE_PAGE_SIZE) break
  }

  const outcome = {
    cutoff,
    retention_days: RETENTION_DAYS,
    deleted,
    pages,
    kept_recent_attempts: kept,
    cap_reached: capReached,
  }

  if (failure) {
    logError('cron.purge-glofox-webhook-events', `${failure.step} failed, not stamping`, { ...outcome, err: failure.message })
    return NextResponse.json({
      success: false,
      error: `purge failed at the ${failure.step}: ${failure.message}`,
      data: outcome,
    }, { status: 500 })
  }

  logInfo('cron.purge-glofox-webhook-events', 'run complete', outcome)
  await stampHeartbeat(HEARTBEAT_NAME, outcome)
  return NextResponse.json({ success: true, data: outcome })
}

/**
 * The subset of `ids` with a glofox_webhook_attempts row processed on or
 * after `cutoff`. Paged: one event row can have many attempts, and an unpaged
 * read would stop at 1,000 rows and miss the rest. Never throws on a
 * PostgREST error; returns it.
 *
 * @returns {Promise<{ ids: Set<string>, error: string|null }>}
 */
async function idsWithRecentAttempts(db, ids, cutoff) {
  const found = new Set()
  for (let offset = 0; ; offset += GUARD_PAGE_SIZE) {
    const { data, error } = await db.from('glofox_webhook_attempts')
      .select('id, event_row_id')
      .in('event_row_id', ids)
      .gte('processed_at', cutoff)
      .order('id', { ascending: true })
      .range(offset, offset + GUARD_PAGE_SIZE - 1)
    if (error) return { ids: found, error: error.message }
    const rows = data || []
    for (const r of rows) if (r?.event_row_id) found.add(r.event_row_id)
    if (rows.length < GUARD_PAGE_SIZE) return { ids: found, error: null }
  }
}
