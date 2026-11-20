// Vercel cron — ATTHISTORY.1: the one-time full Glofox booking-history read.
//
// WHY THIS EXISTS
// ───────────────
// Every Glofox booking read is a 30-day window (fetchUserBookingsResult), so
// the CRM could not say whether a contact had EVER attended a class: on
// 31 Oct 2026 only 658 of 8,851 Stillorgan contacts carried last_attended_at,
// and a former member whose last class predates the CRM looked exactly like a
// lead who never came in. The Stillorgan marketing segments (been in →
// win-back, never been in → trial nurture) are that split; mig 595 parked the
// returning board for want of it.
//
// WHAT THIS DOES
// ──────────────
// Every 10 minutes, for every Glofox studio (the membership seam, like the
// other Glofox crons), up to HISTORY_PER_TICK Glofox-linked contacts whose
// contacts.glofox_history_synced_at (mig 793) is NULL, oldest contact first,
// sibling-studio Glofox members included (GLOFOXREADERS.1):
//   1. read the WHOLE booking history, every page back ten years
//      (fetchUserBookingHistoryResult; a failed page fails the read, because a
//      partial newest-first history that shows no attendance would be stored
//      as "never attended" and never re-checked);
//   2. write historyPatch(): last_attended_at / last_booked_at advance-only
//      (never regressed; the 7-/30-day counts stay with attendance-refresh),
//      and the cursor stamped WHATEVER the answer, so no contact can pin the
//      front of the queue (DETAILBACKFILL.1). The contacts whose read failed
//      are listed on the run's glofox_sync_runs row (summary.failed_ids) for
//      an operator to NULL back for a second pass.
// A contact linked to Glofox later is read on a following tick, so the fact
// stays complete; a tick with nothing pending is healthy and stamps.
//
// A location whose candidate read or credentials failed did no work: it is
// reported failed and the heartbeat is withheld, so a broken sweep pages
// rather than looking like a finished one (GLOFOX414.1). A failed location
// answers success:false at 200 as before; a run where no studio completed (each
// one failed, or the only Glofox studio's credentials could not be read at
// discovery, which used to stamp as an idle run) answers 500 (ROUTEWRAP.C11).
//
// Auth, the error boundary and the stamp: defineCron. Responses carry fixed
// lines; database text and error detail go to the log and the run row.
import { defineCron } from '@/lib/define-cron'
import { glofoxCredentialsForLocation, fetchUserBookingHistoryResult, glofoxHttpStats, glofoxHttpStatsSince } from '@/lib/glofox'
import { GLOFOX_SETTINGS_UNREADABLE_MESSAGE } from '@/lib/glofox-settings-read'
import { locationsWithSource, skippedSummary } from '@/lib/membership/locations-for-source'
import { glofoxCrossoverContactIds } from '@/lib/glofox-crossover'
import { logWarn, logError } from '@/lib/log'
import {
  HISTORY_PER_TICK, HISTORY_FAILED_IDS_CAP,
  historyPatch, historyHasAttendance, listHistoryCandidates, countHistoryRemaining, historyOutcome,
} from '@/lib/glofox-attendance-history'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

// Reads in flight at once. A long history is several GETs per contact, so this
// is lower than the detail backfill's 5; glofoxFetch backs off on a 429.
const GLOFOX_CONCURRENCY = 3
// Stop taking new contacts this close to the Vercel ceiling; the rest are the
// next tick's page because every attempt stamps its contact.
const TIME_BUDGET_MS = 250_000

const MISSING_CREDS_MESSAGE = 'Glofox credentials missing on this location.'
// The location errors the response may carry; anything else (database text)
// is answered as a fixed line and kept on the run row and in the log.
const PUBLIC_LOCATION_ERRORS = new Set([GLOFOX_SETTINGS_UNREADABLE_MESSAGE, MISSING_CREDS_MESSAGE])
const publicLocationError = (msg) => (PUBLIC_LOCATION_ERRORS.has(msg) ? msg : 'Location run failed')

export const GET = defineCron({ heartbeat: 'glofox-attendance-history' }, async ({ db }) => {
  const startedAt = Date.now()
  const httpBefore = glofoxHttpStats()

  const { eligible, skipped, error: locErr } = await locationsWithSource(db, 'glofox', { module: 'glofox-attendance-history' })
  if (locErr) {
    logError('glofox-attendance-history', 'list locations failed; heartbeat not stamped', { err: locErr.message })
    return { ok: false, body: { error: 'Could not read the Glofox studios' } }
  }

  const perLocation = []
  let budgetExhausted = false
  for (const loc of eligible) {
    if (budgetExhausted) break
    const res = await readLocation(db, loc, startedAt)
    perLocation.push(res)
    if (res.budget_exhausted) budgetExhausted = true
  }

  const body = {
    locations_processed: perLocation.length,
    locations_skipped: skipped.length,
    ...skippedSummary(skipped),
    budget_exhausted: budgetExhausted,
    per_location: perLocation,
  }
  const failed = perLocation.filter((r) => r.status === 'failed')
  const unknown = skipped.filter((s) => s.state === 'unknown')
  const completed = perLocation.length - failed.length
  if (failed.length > 0 || (completed === 0 && unknown.length > 0)) {
    logError('glofox-attendance-history', 'location run failed; heartbeat not stamped', {
      failed: [
        ...failed.map((r) => ({ locationId: r.location_id, error: r.error })),
        ...(completed === 0 ? unknown.map((s) => ({ locationId: s.id, error: 'membership source state unknown' })) : []),
      ],
    })
    for (const r of failed) r.error = publicLocationError(r.error)
    return { ok: false, status: completed === 0 ? 500 : 200, body }
  }
  return { body, outcome: historyOutcome(perLocation, budgetExhausted, glofoxHttpStatsSince(httpBefore), skippedSummary(skipped)) }
})

/** One studio's slice of the sweep, within the shared time budget. */
async function readLocation(db, location, startedAt) {
  const summary = { read: 0, no_bookings: 0, attended: 0, truncated: 0, fetch_failed: 0, update_failed: 0 }
  const failedIds = []
  const httpBefore = glofoxHttpStats()
  let budgetExhausted = false
  let eligibleCount = 0
  let remaining = null

  // Audit row up-front so a mid-run timeout still leaves a trace (the shape
  // the other Glofox crons use).
  const { data: runRow, error: runErr } = await db
    .from('glofox_sync_runs')
    .insert({
      location_id: location.id,
      filter_used: { attendance_history: true, per_tick: HISTORY_PER_TICK, concurrency: GLOFOX_CONCURRENCY },
      status: 'running',
    })
    .select('id')
    .single()
  if (runErr) {
    logWarn('glofox-attendance-history', 'audit run row insert failed', { locationId: location.id, err: runErr.message })
  }
  const runId = runRow?.id

  try {
    const creds = await glofoxCredentialsForLocation(db, location.id)
    if (creds.readError) throw new Error(GLOFOX_SETTINGS_UNREADABLE_MESSAGE)
    if (!creds.branchId || !creds.apiKey || !creds.apiToken) {
      throw new Error(MISSING_CREDS_MESSAGE)
    }

    const crossover = await glofoxCrossoverContactIds(db, location.id)
    if (crossover.error) {
      logWarn('glofox-attendance-history', 'crossover contacts unreadable; reading studio contacts only', {
        locationId: location.id, err: crossover.error,
      })
    }
    const crossoverIds = crossover.ids

    const items = await listHistoryCandidates(db, location.id, crossoverIds)
    eligibleCount = items.length

    let cursor = 0
    const worker = async () => {
      for (;;) {
        if (Date.now() - startedAt > TIME_BUDGET_MS) { budgetExhausted = true; return }
        const idx = cursor++
        if (idx >= items.length) return
        await readOne(db, creds, items[idx], summary, failedIds)
      }
    }
    await Promise.all(Array.from({ length: GLOFOX_CONCURRENCY }, worker))

    if (summary.fetch_failed > 0) {
      logWarn('glofox-attendance-history', 'history reads failed; those contacts are stamped and listed on the run row', {
        locationId: location.id, fetchFailed: summary.fetch_failed, runId,
      })
    }
    // A stamp that keeps failing rebuilds the re-read loop (bounded at
    // HISTORY_PER_TICK a tick), so it is an error, once per run.
    if (summary.update_failed > 0) {
      logError('glofox-attendance-history', 'could not write the history patch; those contacts will be re-read next tick', {
        locationId: location.id, updateFailed: summary.update_failed,
      })
    }

    remaining = await countHistoryRemaining(db, location.id, crossoverIds)

    if (runId) {
      const { error: runUpdErr } = await db.from('glofox_sync_runs').update({
        finished_at: new Date().toISOString(),
        duration_ms: Date.now() - startedAt,
        leads_processed: summary.read,
        total_available: eligibleCount,
        summary: { ...summary, remaining, failed_ids: failedIds, glofox_http: glofoxHttpStatsSince(httpBefore) },
        status: 'completed',
      }).eq('id', runId)
      if (runUpdErr) logWarn('glofox-attendance-history', 'audit run row update failed', { runId, err: runUpdErr.message })
    }
    return {
      location_id: location.id,
      location_name: location.name,
      status: 'completed',
      eligible: eligibleCount,
      remaining,
      summary,
      budget_exhausted: budgetExhausted,
    }
  } catch (e) {
    const msg = e?.message || 'unknown error'
    if (runId) {
      const { error: runUpdErr } = await db.from('glofox_sync_runs').update({
        finished_at: new Date().toISOString(),
        duration_ms: Date.now() - startedAt,
        first_error: msg,
        summary: { ...summary, failed_ids: failedIds },
        status: 'failed',
      }).eq('id', runId)
      if (runUpdErr) logWarn('glofox-attendance-history', 'audit run row update failed', { runId, err: runUpdErr.message })
    }
    logError('glofox-attendance-history', 'location run failed', { locationId: location.id, err: msg })
    return {
      location_id: location.id,
      location_name: location.name,
      status: 'failed',
      error: msg,
      eligible: eligibleCount,
      remaining,
      summary,
      budget_exhausted: budgetExhausted,
    }
  }
}

/** Read one contact's history and stamp it, whatever the answer. */
async function readOne(db, creds, contact, summary, failedIds) {
  const r = await fetchUserBookingHistoryResult(creds, contact.glofox_member_id)
  let patch
  if (!r.ok) {
    summary.fetch_failed++
    if (failedIds.length < HISTORY_FAILED_IDS_CAP) failedIds.push(contact.id)
    patch = historyPatch(contact, null)
  } else {
    summary.read++
    if (r.bookings.length === 0) summary.no_bookings++
    if (historyHasAttendance(r.bookings)) summary.attended++
    if (r.truncated) summary.truncated++
    patch = historyPatch(contact, r.bookings)
  }
  // The stamp IS the cursor: judge the write and the row it touched.
  const { data, error } = await db
    .from('contacts')
    .update(patch)
    .eq('id', contact.id)
    .select('id')
  if (error || !data || data.length === 0) summary.update_failed++
}
