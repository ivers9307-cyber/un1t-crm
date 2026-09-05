// POST /api/admin/webhook-dead-letter/[id]/replay
//
// Operator replay of a single dead-letter row (MAIL-DEADLETTER.1 rewrote the
// original registry-only trigger).
//
// WHO. Master, or OWNER AT THE LOCATION THE ROW BELONGS TO (hasRoleAtLocation,
// via the shared ../../_helpers.js that the resolve route judges by too —
// never `user.role`, which is the caller's role at whichever studio happens to
// be ACTIVE and let an owner of studio B act on studio A's rows). A row the
// caller cannot see answers 404, not 403, so ids cannot be enumerated (CLAUDE.md
// detail-route rule). A row with no location_id is master-only — UNLESS it is
// an inbound email whose recipient address now resolves to a mailbox: then
// visibility follows where the mail WOULD file. That is the primary replay
// story — `no_matching_mailbox` rows are stamped NULL by design (DEADLETTER-
// LOC.1: inventing a location would repeat the oldest-active-location bug), the
// operator configures the mailbox, and the row still says NULL.
//
// WHAT. Two kinds of re-driver, one driver (src/lib/webhook-replay.js):
//   • registry providers (inbody, postmark ingest failures) — the same
//     idempotent re-drivers the cron and QStash worker run unattended;
//   • postmark_inbound — replayInboundDeadLetter, which re-runs THE inbound
//     pipeline (claim → classify → process → release) on the payload the row
//     kept verbatim. Operator-only: see MANUAL_REPLAY_PROVIDERS for why it
//     must never be auto-replayed.
//
// ONE OPERATOR AT A TIME (review fix). Before anything is re-driven the route
// CLAIMS the row: a conditional UPDATE that stamps last_attempt_at only where
// it is NULL or older than REPLAY_CLAIM_WINDOW_MS, judged by the rows it
// touched (a zero-row UPDATE is not an error in PostgREST). Two operators — or
// two tabs — pressing Replay within a second used to BOTH find the inbound
// dedupe claim `stale` and both insert a ticket (orphan ticket + double staff
// push); now the second answers 200 `{ recorded:false, reason:'claim_in_flight' }`
// and runs nothing. The claim is taken AFTER the visibility/state gates so a
// 404/409/400 never stamps the row. No new column: last_attempt_at is already
// the attempt stamp every consumer of this table reads.
//
// OUTCOME ON THE ROW. replayDeadLetter stamps last_attempt_at (= the replay
// time) and attempts++ on every run; `status: resolved` + resolved_at ONLY
// when the re-driver recorded something; a clean run that recorded nothing
// (mailbox still missing, no sender, a claim still in flight) leaves the
// status alone and writes the reason to `error`, so the morgue row says what
// the replay found. No new column: last_attempt_at already IS the replay
// stamp for the automatic consumers, and `error` is the row's one free-text
// field. Response: { success, status, recorded, reason?, result?, error?, id,
// provider } — `success` mirrors "the row is now resolved".
//
// Only pending/failed rows are acted on: resolved → 409, discarded → 400. A
// provider with no re-driver at all (glofox — action replay is not
// idempotent) → 400.
//
// Everything this route reads or writes directly is webhook_dead_letter — a
// tenant table to check-location-scoping since the review fix (it used to sit
// in TABLE_EXCLUDE on the false claim that only master-only tooling read it);
// canReplayDeadLetter is the registered scoping helper. The tenant queries
// inside the re-drivers run on rows the guard above has already judged.

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { isReplayable, isManuallyReplayable, replayDeadLetter } from '@/lib/webhook-replay'
import { replayInboundDeadLetter } from '@/app/api/webhooks/postmark-inbound/[token]/route'
// resolveDeadLetterLocation + canReplayDeadLetter moved to ../../_helpers.js
// (review fix) so the resolve route judges visibility identically.
import { resolveDeadLetterLocation, canReplayDeadLetter } from '../../_helpers'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
// Same cap as the inbound route it re-runs: the function must be dead well
// inside the 60s STALE_CLAIM_MS the inbound pipeline (and the claim window
// below) treat as "the owner cannot still be running".
export const maxDuration = 20

// A replay claim (last_attempt_at) younger than this belongs to a run that may
// still be executing — mirrors the inbound route's STALE_CLAIM_MS (60s = 3×
// maxDuration, with clock-skew margin). Deliberately a local constant: the
// inbound module is mocked in this route's tests, so an imported value would
// read `undefined` there.
const REPLAY_CLAIM_WINDOW_MS = 60_000

/** The re-driver for a provider, or null when nothing may replay it. */
function resolveReplayer(provider) {
  if (provider === 'postmark_inbound') return replayInboundDeadLetter
  // Registry providers: undefined lets replayDeadLetter pick its own entry.
  if (isReplayable(provider)) return undefined
  return null
}

export async function POST(request, { params }) {
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  }

  // Next 16 hands route handlers a PROMISE; `await` also accepts a plain object.
  const { id } = await params
  if (!id) {
    return NextResponse.json({ success: false, error: 'Missing id' }, { status: 400 })
  }

  const db = createServerClient()

  const { data: row, error: fetchErr } = await db
    .from('webhook_dead_letter')
    .select('id, provider, payload, status, attempts, location_id, last_attempt_at')
    .eq('id', id)
    .single()
  if (fetchErr || !row) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }

  // Visibility BEFORE any state answer: a 409/400 for a row the caller cannot
  // see would confirm the id exists.
  const locationId = await resolveDeadLetterLocation(db, row)
  if (!canReplayDeadLetter(user, locationId)) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }

  if (row.status === 'resolved') {
    return NextResponse.json({ success: false, error: 'Row already resolved' }, { status: 409 })
  }
  if (row.status === 'discarded') {
    return NextResponse.json({ success: false, error: 'Row is discarded — cannot replay' }, { status: 400 })
  }

  const replayer = resolveReplayer(row.provider)
  if (replayer === null || !isManuallyReplayable(row.provider)) {
    return NextResponse.json({ success: false, error: 'provider not replayable' }, { status: 400 })
  }

  // Claim the row atomically BEFORE re-driving it. Judge the rows touched,
  // never the absence of an error (BAREWRITE: a zero-row UPDATE resolves clean).
  const claimFloor = new Date(Date.now() - REPLAY_CLAIM_WINDOW_MS).toISOString()
  const { data: claimed, error: claimErr } = await db
    .from('webhook_dead_letter')
    .update({ last_attempt_at: new Date().toISOString() })
    .eq('id', id)
    .or(`last_attempt_at.is.null,last_attempt_at.lt.${claimFloor}`)
    .select('id')
  if (claimErr) {
    // Unknown claim state — never replay on it; the operator can simply retry.
    return NextResponse.json({ success: false, error: claimErr.message }, { status: 500 })
  }
  if (!claimed || claimed.length === 0) {
    return NextResponse.json({
      success: false,
      status: row.status,
      id: row.id,
      provider: row.provider,
      recorded: false,
      reason: 'claim_in_flight',
    })
  }

  const result = await replayDeadLetter(db, row, { replayer })

  const body = {
    success: result.ok,
    status: result.status,
    id: row.id,
    provider: row.provider,
    recorded: result.ok ? true : (result.recorded ?? false),
  }
  if (result.reason) body.reason = result.reason
  if (result.result !== undefined) body.result = result.result
  if (result.error) body.error = result.error

  return NextResponse.json(body)
}
