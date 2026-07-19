// QSTASH.9 — push-delivery worker for the external_export_jobs queue
// (Strava uploads today; the queue is provider-generic).
//
// QStash POSTs { id } here (published fire-and-forget by
// enqueueExportsForSession in src/lib/external-export.js per
// freshly-inserted job, onto the `strava-exports` QUEUE with
// parallelism 2 — each export burns 2–4 Strava API calls against a
// 100-req/15-min app budget, and a class ending fans out one
// endSession per member, so an "end all" must never become 30
// concurrent uploads), signed with an Upstash-Signature JWT. We verify
// the signature, re-fetch the row, and run it through the SAME per-job
// unit the run-strava-exports cron uses (processExportJob in
// src/lib/external-export.js).
//
// NOTE the claim here is NOT a compare-and-swap: processOneJob flips
// the row to 'processing' blind, a documented accepted race (Strava
// de-dupes uploads by external_id). That shapes the status contract:
//
//   200 — done, INCLUDING job failures. processExportJob already ran
//         the cron's failure bookkeeping (markFailed: re-queued with
//         the queue's OWN backoff — next_attempt_at now+1m…6h — under
//         MAX_ATTEMPTS; terminal 'failed' + integration last_error at
//         the cap). 500 would make QStash re-deliver: early retries
//         no-op on the next_attempt_at gate, late ones would race the
//         cron on the non-CAS claim and burn Strava rate budget on an
//         upload the schedule already owns. Retries belong to the
//         cron, full stop (the invoice-analysis stance).
//   401 — signature rejected (not retryable-by-us; QStash will retry,
//         and each retry re-verifies — a rotated key heals this)
//   500 — infrastructure error only (row fetch failed): nothing was
//         processed, no bookkeeping ran, a QStash retry genuinely
//         helps.
//
// Eligibility fetch: status 'queued' AND next_attempt_at due. NOT
// 'processing' — a QStash per-delivery timeout redelivering mid-upload
// must 200-skip while the ORIGINAL invocation keeps working; rows a
// crashed invocation left in 'processing' are recovered by the cron's
// batch select (which includes 'processing' — CRON-ONLY, unchanged).
// The next_attempt_at bound keeps a re-queued row's backoff on the
// cron's schedule even if a stray delivery arrives early.
//
// The external_export_jobs table stays the source of truth throughout —
// QStash going away entirely (env vars unset) reverts cleanly to
// cron-only processing.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { verifyQStashSignature, STRAVA_EXPORTS_WORKER_PATH } from '@/lib/qstash'
import { processExportJob } from '@/lib/external-export'
import { getAppUrl } from '@/lib/app-url'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60 // same budget as the cron — one export fits well inside it

/**
 * missing_keys means WE are misconfigured (route reachable but signing keys
 * unset) — 503 flags it as a server problem. Every other reason is a bad
 * or forged delivery — 401.
 */
export function statusForVerifyFailure(reason) {
  return reason === 'missing_keys' ? 503 : 401
}

export function responseForOutcome(outcome) {
  if (outcome.status === 'succeeded') {
    return { status: 200, body: { success: true, processed: true } }
  }
  if (outcome.status === 'skipped') {
    return { status: 200, body: { success: true, skipped: true } }
  }
  // 'failed' — 200, not 500 (see header): the bookkeeping already
  // re-queued it on the cron's backoff schedule (or went terminal).
  return {
    status: 200,
    body: { success: true, failed: true, error: outcome.error || 'processing_failed' },
  }
}

export async function POST(request) {
  // Raw body FIRST — the signature's body claim hashes the exact bytes
  // delivered, so any parse-then-restringify would break verification.
  const rawBody = await request.text()

  let expectedUrl = null
  try {
    expectedUrl = `${getAppUrl()}${STRAVA_EXPORTS_WORKER_PATH}`
  } catch {
    // NEXT_PUBLIC_APP_URL unset — verify everything else but skip the
    // sub check rather than rejecting deliveries over our own config.
    console.error('[qstash strava-exports worker] NEXT_PUBLIC_APP_URL unset; skipping sub-claim check')
  }

  const verdict = verifyQStashSignature({
    signature: request.headers.get('upstash-signature'),
    rawBody,
    url: expectedUrl || undefined,
  })
  if (!verdict.ok) {
    console.warn(`[qstash strava-exports worker] delivery rejected: ${verdict.reason}`)
    return NextResponse.json(
      { success: false, error: verdict.reason },
      { status: statusForVerifyFailure(verdict.reason) }
    )
  }

  let id
  try {
    id = JSON.parse(rawBody)?.id
  } catch {
    return NextResponse.json({ success: false, error: 'invalid_json' }, { status: 400 })
  }
  if (!id) {
    return NextResponse.json({ success: false, error: 'missing_id' }, { status: 400 })
  }

  const db = createServerClient()

  // Same eligibility as the cron's due-jobs select minus 'processing'
  // (see header) — and the same columns: processExportJob needs the
  // pre-claim attempts for its bookkeeping. A processing/succeeded/
  // failed/skipped or not-yet-due row is a clean 200 skip — QStash
  // must not redeliver it.
  const nowIso = new Date().toISOString()
  const { data: rows, error: fetchErr } = await db
    .from('external_export_jobs')
    .select('id, session_id, contact_id, provider, attempts')
    .eq('id', id)
    .eq('status', 'queued')
    .lte('next_attempt_at', nowIso)
    .limit(1)

  if (fetchErr) {
    console.error('[qstash strava-exports worker] row fetch failed:', fetchErr.message)
    return NextResponse.json({ success: false, error: fetchErr.message }, { status: 500 })
  }

  const job = rows?.[0]
  if (!job) {
    return NextResponse.json({ success: true, skipped: true })
  }

  const outcome = await processExportJob(db, job)
  if (outcome.status === 'failed') {
    console.warn(`[qstash strava-exports worker] export ${job.id} failed (re-queued/terminal per attempts): ${outcome.error}`)
  }
  const { status, body } = responseForOutcome(outcome)
  return NextResponse.json(body, { status })
}
