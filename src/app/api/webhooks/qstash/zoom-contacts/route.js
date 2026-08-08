// ZOOMSYNC.1 — push-delivery worker for the zoom-contacts queue. Applies
// exactly one external-contact write per delivery.
//
// Status-code contract with QStash retries:
//   200 — applied (including the idempotent 409-duplicate and 404-already-gone
//         cases, which external-contacts.js already folds into ok:true)
//   400 — the job is malformed; retrying will never help
//   401 — signature rejected (QStash retries; a rotated key heals it)
//   503 — OUR signing keys are unset, i.e. we are misconfigured, not them
//   500 — Zoom failed; QStash should retry, and every write here is idempotent

import { NextResponse } from 'next/server'
import { verifyQStashSignature, ZOOM_CONTACTS_WORKER_PATH } from '@/lib/qstash'
import { getAppUrl } from '@/lib/app-url'
import { createContact, updateContact, deleteContact } from '@/lib/zoom/external-contacts'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
// 120, not 60: zoomFetch retries once on 429 honouring Retry-After (capped at
// 30s) before a 15s-timeout attempt, so a single rate-limited write can
// legitimately run ~45s. A 60s budget would leave almost no headroom.
export const maxDuration = 120

export function statusForVerifyFailure(reason) {
  return reason === 'missing_keys' ? 503 : 401
}

export async function POST(request) {
  // Raw body FIRST — the signature hashes the exact bytes delivered, so any
  // parse-then-restringify would break verification.
  const rawBody = await request.text()

  let expectedUrl
  try {
    expectedUrl = `${getAppUrl()}${ZOOM_CONTACTS_WORKER_PATH}`
  } catch {
    expectedUrl = undefined
  }

  const verdict = verifyQStashSignature({
    signature: request.headers.get('upstash-signature'),
    rawBody,
    url: expectedUrl,
  })
  if (!verdict.ok) {
    console.warn(`[qstash zoom-contacts worker] delivery rejected: ${verdict.reason}`)
    return NextResponse.json(
      { success: false, error: verdict.reason },
      { status: statusForVerifyFailure(verdict.reason) },
    )
  }

  let job
  try { job = JSON.parse(rawBody) } catch {
    return NextResponse.json({ success: false, error: 'invalid_json' }, { status: 400 })
  }

  let result
  if (job?.op === 'create' && job.e164 && job.name) {
    result = await createContact({ e164: job.e164, name: job.name, contactId: job.contactId })
  } else if (job?.op === 'update' && job.zoomId && job.name) {
    result = await updateContact({ zoomId: job.zoomId, name: job.name, contactId: job.contactId })
  } else if (job?.op === 'delete' && job.zoomId) {
    result = await deleteContact({ zoomId: job.zoomId })
  } else {
    return NextResponse.json({ success: false, error: 'unknown_op' }, { status: 400 })
  }

  if (!result.ok) {
    console.error(`[qstash zoom-contacts worker] ${job.op} failed: ${result.error}`)
    return NextResponse.json({ success: false, error: result.error }, { status: 500 })
  }
  return NextResponse.json({ success: true, op: job.op })
}
