// ORGCONTACTS.1 (plan Task 10) — the nightly contact_studios reconcile.
//
// contact_studios (mig 764) is kept live by three DEFINER triggers and the two
// syncs, but its lifecycle rules derive from source rows that change without
// any of those firing (a Glofox membership ending is a contacts column, a
// un1t.online client row vanishing from a pull is a mirror write), so every
// night public.reconcile_contact_studios(NULL) re-derives every (contact,
// studio) pair from the sources: first_seen_at never later, last_seen_at
// never earlier, ended_at set and cleared with status, rows never deleted.
//
// Batched RPCs (RECONCILEBATCH.1, mig 846), one heartbeat
// ('contact-studios-reconcile', daily, 2h grace; mig 764 seeds the row). A failed RPC is a 500 with NO stamp: the health check
// reads is_stale, so a night that did nothing must read as stale.
//
// Schedule: vercel.json, 03:30 PLATFORM_TZ (after the 03:00 Glofox sync).
//
// ORGCONTACTS.8 — the run time is measured: `duration_ms` rides on the
// heartbeat's last_outcome and the response, so cron_heartbeats shows how long
// last night's reconcile took, and a run past SLOW_RUN_MS (half of
// maxDuration) logs a warning while there is still headroom, before the table
// grows into Vercel's limit and the function is killed with no stamp.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { logError, logInfo, logWarn } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

export const CRON_NAME = 'contact-studios-reconcile'
export const SLOW_RUN_MS = (maxDuration * 1000) / 2
/** Contacts per batch: ~5% of the table, well inside the 8 s statement timeout. */
export const BATCH_CONTACTS = 500
/** Stop starting batches with headroom before maxDuration kills the function. */
export const RUN_DEADLINE_MS = (maxDuration - 30) * 1000

export async function GET(request) {
  const auth = request.headers.get('authorization') || ''
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  }

  const db = createServerClient()
  const startedAt = Date.now()

  // RECONCILEBATCH.1 (mig 846) — in batches of BATCH_CONTACTS contacts. One
  // call over every (contact, studio) pair ran past the API's 8 s statement
  // timeout (16 Nov), so the night did nothing. Each batch is its own call and
  // transaction; a batch that fails stops the run with NO stamp (the next
  // night starts again from the first contact, which is safe: the upsert is
  // idempotent).
  const counts = { inserted: 0, updated: 0, ended: 0, unchanged: 0, skipped_no_primary: 0, batches: 0 }
  let after = null
  for (;;) {
    if (Date.now() - startedAt > RUN_DEADLINE_MS) {
      logError(CRON_NAME, 'reconcile ran out of time before the last batch; no heartbeat', { batches: counts.batches, after, duration_ms: Date.now() - startedAt })
      return NextResponse.json({ success: false, error: 'reconcile did not finish in time', ...counts }, { status: 500 })
    }
    const { data, error } = await db.rpc('reconcile_contact_studios_batch', { p_after: after, p_limit: BATCH_CONTACTS })
    if (error) {
      logError(CRON_NAME, 'reconcile_contact_studios_batch failed; no heartbeat', {
        code: error.code ?? null, message: error.message, batches: counts.batches, duration_ms: Date.now() - startedAt,
      })
      return NextResponse.json({ success: false, error: error.message || 'reconcile failed' }, { status: 500 })
    }
    const row = Array.isArray(data) ? data[0] : data
    counts.batches++
    counts.inserted += Number(row?.inserted ?? 0)
    counts.updated += Number(row?.updated ?? 0)
    counts.ended += Number(row?.ended ?? 0)
    counts.unchanged += Number(row?.unchanged ?? 0)
    if (row?.done || !row?.last_contact_id || row.last_contact_id === after) break
    after = row.last_contact_id
  }

  // Contacts with no home studio, as the single call reported (diagnostic).
  const { count: noPrimary, error: noPrimaryErr } = await db
    .from('contacts').select('id', { count: 'exact', head: true }).is('location_id', null)
  if (noPrimaryErr) logWarn(CRON_NAME, 'could not count contacts with no studio', { err: noPrimaryErr })
  counts.skipped_no_primary = noPrimary ?? 0
  const durationMs = Date.now() - startedAt
  counts.duration_ms = durationMs

  if (durationMs > SLOW_RUN_MS) {
    logWarn(CRON_NAME, 'contact_studios reconcile is past half its time limit', { duration_ms: durationMs, limit_ms: maxDuration * 1000 })
  }
  logInfo(CRON_NAME, 'contact_studios reconciled', counts)
  await stampHeartbeat(CRON_NAME, counts)
  return NextResponse.json({ success: true, ...counts })
}
