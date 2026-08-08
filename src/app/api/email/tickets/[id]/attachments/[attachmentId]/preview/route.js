// EMAIL-ATTACH-PREVIEW.1 —
// GET /api/email/tickets/[id]/attachments/[attachmentId]/preview
//
// Mints a short-lived signed INLINE URL for ONE stored attachment, so the
// operator can look at a member's photo or PDF without downloading it first.
//
// ══ WHY THIS IS A SEPARATE ROUTE ════════════════════════════════════
//
// A preview URL and a download URL differ by exactly one Storage option:
// `{ download: filename }`, which is what makes Storage answer
// `Content-Disposition: attachment`. The obvious design is one route with a
// `?disposition=` parameter — and it is the wrong one, because it makes the
// disposition something a REQUEST asserts. From there it is a very short walk
// to a parameter that carries more than a disposition.
//
// So there is no parameter. There are two routes, each with one hard-coded
// behaviour, sharing one gate (../../_helpers → loadAttachmentForTicket):
//
//   …/attachments/[attachmentId]           always downloads, every type
//   …/attachments/[attachmentId]/preview   always inline, allow-listed types only
//
// Nothing a caller can send changes which of those they hit beyond the URL they
// chose, and neither one accepts a Storage option.
//
// ══ THE ALLOW-LIST IS ENFORCED TWICE, ON PURPOSE ════════════════════
//
// Here, so the refusal is a 404 the UI can act on — and again inside
// signedAttachmentPreviewUrl(), which returns null for a non-previewable type
// whoever calls it. The second check is not redundant: this route is the only
// caller today, and the whole point of putting the rule next to the signing is
// that it survives the second caller. image/svg+xml is the type that matters —
// scriptable markup from an unauthenticated stranger, which must never acquire
// an inline handle to its bytes, not even one nothing renders yet.
//
// 404 — never 403 — for every refusal, and a non-previewable type is one of
// them: the caller already holds the ticket and already knows the file exists
// (the thread lists it), so this says nothing new, and it keeps every refusal
// on this surface indistinguishable.
//
// storage_path is never returned. The signed URL is the only handle a client
// gets, and it expires.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { signedAttachmentPreviewUrl } from '@/lib/email-attachments-server'
import { attachmentPreviewKind } from '@/lib/email-attachment-preview'
import { loadAttachmentForTicket } from '../../_helpers'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// The same TTL as the download route. A preview is minted when the operator
// opens the file and rendered immediately, so five minutes is generous; a URL
// scraped out of a network tab is worthless long before anyone reads it.
const SIGNED_URL_TTL_SECONDS = 300

export async function GET(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const db = createServerClient()

  const loaded = await loadAttachmentForTicket(db, user, params.id, params.attachmentId)
  if (loaded.response) return loaded.response
  const { attachment } = loaded

  const kind = attachmentPreviewKind(attachment.mime_type)
  if (!kind) {
    // Not a fault, and the UI must not render it as one: this is a Word
    // document or a HEIC photo or an SVG, and the honest answer is the chip's
    // download button, which is already on screen.
    return NextResponse.json({
      success: false,
      error: 'No preview is available for this file type.',
      data: { preview_kind: null },
    }, { status: 404 })
  }

  const url = await signedAttachmentPreviewUrl(db, attachment.storage_path, {
    mimeType: attachment.mime_type,
    ttlSeconds: SIGNED_URL_TTL_SECONDS,
  })
  if (!url) {
    // The row says stored but Storage would not sign it. A 500, not a 404, for
    // the same reason as the download route: "missing from the bucket" and "you
    // may not have this file" are different problems for an operator — and the
    // UI degrades to the download button either way.
    return NextResponse.json(
      { success: false, error: 'Could not prepare a preview for that file.' },
      { status: 500 }
    )
  }

  return NextResponse.json({
    success: true,
    data: {
      url,
      preview_kind: kind,
      filename: attachment.filename,
      mime_type: attachment.mime_type,
      size_bytes: attachment.size_bytes,
      expires_in: SIGNED_URL_TTL_SECONDS,
    },
  })
}
