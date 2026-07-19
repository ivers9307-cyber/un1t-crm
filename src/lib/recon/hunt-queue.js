// Shared receipt-hunt queue claim wrapper (QSTASH.10).
//
// Unlike QSTASH.6 (which extracted the cron's inline per-row loop into
// a shared lib), the per-row unit here was ALREADY shared: huntLine
// (./hunt.js) is what the process-receipt-hunts cron runs on each
// RPC-claimed row, and it owns every piece of row bookkeeping — the
// found/not_found status flips, the recon_hunts audit row, and the
// errorFinish path that de-queues a failed line. This lib only adds
// the QStash worker's by-id claim so the two consumers can run
// concurrently against the same table.
//
// Claim semantics: the cron batch-claims via the
// `claim_recon_hunt_batch` RPC (mig 370 — FOR UPDATE SKIP LOCKED,
// which matters when SELECTING N rows without ticks blocking each
// other). The worker claims ONE row by id with a plain conditional
// UPDATE mirroring the RPC's predicate exactly: status still in
// ('uncovered','not_found'), hunt_queued_at still set, hunt_claimed_at
// NULL or staler than the RPC's 10-minute window — stamping a fresh
// hunt_claimed_at. Under READ COMMITTED the loser of a concurrent
// claim re-evaluates the predicate against the winner's committed row
// (fresh hunt_claimed_at → 0 rows → skip), and the RPC's SKIP LOCKED
// skips a row the worker holds mid-claim — claim-exactly-once in both
// directions, no new SQL needed. A consumer that CRASHES mid-hunt
// leaves the row claimed; the RPC's stale-claim arm (>10 min) makes
// the cron re-sweep it, exactly as it always has.
//
// Failure semantics (RCOV.P1, unchanged): huntLine never throws. Its
// 'error' outcome has already run errorFinish — a terminal recon_hunts
// audit row plus dequeueLine (hunt_queued_at cleared WITHOUT touching
// the line's status) — so an errored line is out of the queue until
// next Friday's re-seed. That matches the cron, which tallies 'error'
// as `failed` and never retries it. The worker must therefore 200
// every hunt outcome (see the route header); a QStash retry would
// re-fetch, find nothing queued, and skip.
//
// The FINALIZER (maybeFinalizeWeekly) is deliberately absent from this
// lib: it stays CRON-ONLY. See the worker route header for why.

import { huntLine } from './hunt'

// Mirrors the RPC's stale-claim window (mig 370: hunt_claimed_at <
// now() - interval '10 minutes'). A claim older than this is a crashed
// consumer — re-claimable. Safe for the worker too: maxDuration 300s
// means no invocation can still be running at 10 min, so a stale
// re-claim can never double-hunt.
export const CLAIM_STALE_MINUTES = 10

/**
 * Claim one queued line by id (CAS mirroring the claim_recon_hunt_batch
 * predicate), then hunt it. The QStash worker's entry point.
 *
 * @param {SupabaseClient} db — service-role client
 * @param {object} line — a full recon_bank_lines row (still-queued, per
 *   the worker's eligibility fetch; huntLine needs location_id,
 *   line_date, description, amount, hunt_attempts, …)
 * @returns {Promise<{status: 'skipped'} |
 *   {status: 'hunted', outcome: 'found'|'not_found'|'error'}>}
 */
export async function claimAndHuntLine(db, line) {
  const staleBefore = new Date(Date.now() - CLAIM_STALE_MINUTES * 60_000).toISOString()
  const { data: claimed } = await db
    .from('recon_bank_lines')
    .update({ hunt_claimed_at: new Date().toISOString() })
    .eq('id', line.id)
    .in('status', ['uncovered', 'not_found'])
    .not('hunt_queued_at', 'is', null)
    .or(`hunt_claimed_at.is.null,hunt_claimed_at.lt.${staleBefore}`)
    .select('id')
  if (!claimed || claimed.length === 0) return { status: 'skipped' }

  const result = await huntLine(db, line)
  return { status: 'hunted', ...result }
}
