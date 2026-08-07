// POST /api/email/attachments/upload-sign — EMAIL-OUTBOUND-ATTACH.1, step 1 of
// attaching a file to a reply or a new email.
//
// WHY THE BYTES DO NOT COME THROUGH HERE
// Vercel rejects a request body over ~4.5 MB with a 413 BEFORE the handler
// runs — the same platform limit that forced the inbound Edge shim. A multipart
// POST carrying a 6 MB attachment to the reply route would fail with none of
// our code running and no sentence an operator could act on. So:
//
//   1. THIS ROUTE authorises the upload and mints a signed token for a path IT
//      chose (the browser never proposes one).
//   2. The browser uploads the file DIRECTLY to the private email-attachments
//      bucket with that token (uploadToSignedUrl). No Vercel in the path.
//   3. The send request carries only { draft_id, index, filename, mime } — a
//      few hundred bytes — and the send route REBUILDS the identical key.
//
// Same three-step shape as card receipts, contractor invoices, WhatsApp
// template media and landing-page media; this is the fourth surface in the repo
// to use it and the pattern is deliberately not re-invented.
//
// ══ THE AUTHORISATION IS THE SEND'S OWN ═════════════════════════════
// Signing an upload is permission to put bytes in a studio's bucket and, a
// moment later, to send them to a member. So the gate is not a weaker "can you
// use the CRM" check — it is EXACTLY the gate the send it feeds will apply:
//
//   ticket_id  → loadTicketForUser: the ticket's location, `email_inbox` THERE,
//                and the mailbox the ticket arrived at must be in the caller's
//                visible set. Identical to the reply route.
//   mailbox_id → loadSendingMailbox: the mailbox's location, `email_inbox`
//                THERE, and the mailbox must be one the caller may send as.
//                Identical to the compose route (which now shares the helper).
//
// EXACTLY ONE of the two is accepted. Taking both would create a third
// authorisation shape whose semantics nobody has decided, and taking neither
// would be an unauthenticated write into a shared bucket.
//
// 404 — never 403 — for every refusal, so ticket and mailbox ids stay
// unprobeable, exactly as on the routes this mirrors.
//
// ══ WHAT THIS ROUTE DOES NOT DO ═════════════════════════════════════
// It does not charge quota and it does not write a row. A draft is not an
// attachment: it becomes one when a message it belongs to actually goes out
// (fileOutboundAttachments). Metering here would bill a studio for every file
// someone attached and then thought better of, and would need a release path on
// a surface that has no reliable "the operator gave up" signal.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'
import { EMAIL_ATTACHMENT_BUCKET } from '@/lib/email-attachment-quota'
import {
  MAX_OUTBOUND_ATTACHMENT_TOTAL_BYTES,
  outboundDraftPath,
  outboundFileTooLargeError,
} from '@/lib/email-outbound-attachments'
import { OutboundAttachmentSchema } from '@/lib/email-outbound-attachments-server'
import { loadTicketForUser, loadSendingMailbox, ticketNotFound } from '../../tickets/_helpers'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const SignSchema = OutboundAttachmentSchema.extend({
  ticket_id: uuidLike.optional(),
  mailbox_id: uuidLike.optional(),
  // The browser's own figure. Used ONLY to fail early with a useful sentence —
  // the send path re-measures the downloaded bytes and that number is the one
  // that decides both Postmark's ceiling and the mailbox's quota.
  size: z.number().int().positive(),
})

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const validation = await validateBody(request, SignSchema)
  if (!validation.ok) return validation.response
  const body = validation.data

  // Exactly one target. Both or neither is a malformed request, not a partially
  // valid one — there is no sensible way to authorise it.
  const hasTicket = !!body.ticket_id
  const hasMailbox = !!body.mailbox_id
  if (hasTicket === hasMailbox) {
    return NextResponse.json(
      { success: false, error: 'Attach a file to either an existing ticket or a mailbox, not both.' },
      { status: 400 }
    )
  }

  // Cheap and stated before any DB work: one file can never be bigger than the
  // whole-message ceiling, so there is no point authorising an upload that the
  // send would refuse.
  if (body.size > MAX_OUTBOUND_ATTACHMENT_TOTAL_BYTES) {
    return NextResponse.json(
      { success: false, error: outboundFileTooLargeError(body.filename, body.size) },
      { status: 400 }
    )
  }

  const db = createServerClient()

  // THE GATE — the send's own, in both shapes. See the header.
  if (hasTicket) {
    const loaded = await loadTicketForUser(db, user, body.ticket_id)
    if (loaded.response) return loaded.response
  } else {
    const loaded = await loadSendingMailbox(db, user, body.mailbox_id)
    if (loaded.response) return loaded.response
  }

  // THE PATH IS BUILT HERE, FROM THE SESSION'S OWN PROFILE ID. The caller
  // contributes a draft uuid and a small index and nothing else, so the key can
  // only ever land under their own prefix — never another person's drafts,
  // never the canonical `<location_id>/…` half of the bucket, never the shim's
  // `inbound/…` half, never up a `../`.
  let storagePath
  try {
    storagePath = outboundDraftPath({
      profileId: user.id,
      draftId: body.draft_id,
      index: body.index,
      mime: body.mime,
    })
  } catch {
    // Unreachable behind the Zod shapes above; a 404 rather than a 500 because
    // the only way here is a request that named something that cannot exist.
    return ticketNotFound()
  }

  const { data, error } = await db.storage
    .from(EMAIL_ATTACHMENT_BUCKET)
    .createSignedUploadUrl(storagePath)
  if (error || !data?.token) {
    console.error('[email/attachments/upload-sign] could not mint an upload token:', error?.message)
    return NextResponse.json(
      { success: false, error: 'Could not start that upload — try again.' },
      { status: 500 }
    )
  }

  // `path` is returned because uploadToSignedUrl needs it alongside the token.
  // It is not a capability: the token is, and it is bound to this exact key.
  return NextResponse.json({ success: true, data: { path: storagePath, token: data.token } })
}
