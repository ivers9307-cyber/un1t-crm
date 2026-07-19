// QSTASH.4 — push-delivery worker for the contact_imports queue.
//
// QStash POSTs { id } here (published fire-and-forget by the async path
// of /api/contacts/import/commit right after its queue insert), signed
// with an Upstash-Signature JWT. We verify the signature, re-fetch the
// row, and run it through the SAME claim CAS the
// process-contact-imports cron uses (src/lib/contact-import-queue.js) —
// the two consumers race safely; whoever claims first wins and the
// other sees `skipped`.
//
// Status-code contract with QStash retries:
//   200 — done (import ran, or someone else already owns the row)
//   401 — signature rejected (not retryable-by-us; QStash will retry,
//         and each retry re-verifies — a rotated key heals this)
//   500 — the import ran and FAILED; the row is already stamped
//         'failed' for the operator (imports are not blindly retryable
//         — part of the batch may already be written), so QStash's
//         retry re-fetch finds nothing pending and 200-skips.
//
// Long-import timeout behaviour (by design, do not "fix"): imports
// legitimately run for minutes (maxDuration 300, the same budget as the
// cron), and QStash's per-delivery HTTP timeout may be SHORTER than
// that. When QStash gives up waiting and redelivers, the retry finds
// status 'processing' → 200 skipped, while the ORIGINAL invocation
// keeps working to completion — that is CORRECT, not a lost job. An
// invocation that actually CRASHES mid-import leaves the row in
// 'processing'; the cron's stuck-recovery pass (cron-only, unchanged)
// resets it to 'pending' after 5 minutes.
//
// The contact_imports table stays the source of truth throughout —
// QStash going away entirely (env vars unset) reverts cleanly to
// cron-only processing.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { verifyQStashSignature, CONTACT_IMPORTS_WORKER_PATH } from '@/lib/qstash'
import { claimAndProcessImportJob } from '@/lib/contact-import-queue'
import { getAppUrl } from '@/lib/app-url'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300 // 5 min — biggest 50k batch fits (same as the cron)

/**
 * missing_keys means WE are misconfigured (route reachable but signing keys
 * unset) — 503 flags it as a server problem. Every other reason is a bad
 * or forged delivery — 401.
 */
export function statusForVerifyFailure(reason) {
  return reason === 'missing_keys' ? 503 : 401
}

export function responseForOutcome(outcome) {
  if (outcome.status === 'processed') {
    return { status: 200, body: { success: true, processed: true } }
  }
  if (outcome.status === 'skipped') {
    return { status: 200, body: { success: true, skipped: true } }
  }
  return {
    status: 500,
    body: { success: false, error: outcome.error || 'processing_failed' },
  }
}

export async function POST(request) {
  // Raw body FIRST — the signature's body claim hashes the exact bytes
  // delivered, so any parse-then-restringify would break verification.
  const rawBody = await request.text()

  let expectedUrl = null
  try {
    expectedUrl = `${getAppUrl()}${CONTACT_IMPORTS_WORKER_PATH}`
  } catch {
    // NEXT_PUBLIC_APP_URL unset — verify everything else but skip the
    // sub check rather than rejecting deliveries over our own config.
    console.error('[qstash contact-imports worker] NEXT_PUBLIC_APP_URL unset; skipping sub-claim check')
  }

  const verdict = verifyQStashSignature({
    signature: request.headers.get('upstash-signature'),
    rawBody,
    url: expectedUrl || undefined,
  })
  if (!verdict.ok) {
    console.warn(`[qstash contact-imports worker] delivery rejected: ${verdict.reason}`)
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

  // Same eligibility filter as the cron's oldest-pending select: pending
  // only. An already-claimed ('processing' — see the header note on
  // QStash timeouts), completed, failed or rolled-back row is a clean
  // 200 skip — QStash must not redeliver it. Full row: the shared lib
  // needs payload + location_id.
  const { data: rows, error: fetchErr } = await db
    .from('contact_imports')
    .select('*')
    .eq('id', id)
    .eq('status', 'pending')
    .limit(1)

  if (fetchErr) {
    console.error('[qstash contact-imports worker] row fetch failed:', fetchErr.message)
    return NextResponse.json({ success: false, error: fetchErr.message }, { status: 500 })
  }

  const job = rows?.[0]
  if (!job) {
    return NextResponse.json({ success: true, skipped: true })
  }

  const outcome = await claimAndProcessImportJob(db, job)
  if (outcome.status === 'failed') {
    console.warn(`[qstash contact-imports worker] import ${job.id} failed: ${outcome.error}`)
  }
  const { status, body } = responseForOutcome(outcome)
  return NextResponse.json(body, { status })
}
