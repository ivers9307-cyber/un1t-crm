// EMAIL-ATTACH.1 — GET /api/email/tickets/[id]/attachments/[attachmentId]
//
// Mints a short-lived signed DOWNLOAD URL for ONE stored attachment. The
// `email-attachments` bucket is private, so this route and its `/preview`
// sibling are the only ways a browser ever sees the bytes, and the URL expires.
//
// THIS ROUTE ALWAYS DOWNLOADS. It takes no parameters beyond the two path ids —
// no disposition, no transform, no options bag — so there is no request that
// turns it into an inline URL. The inline case is a separate route with a
// separate allow-list (EMAIL-ATTACH-PREVIEW.1), which is what keeps
// "previewable" from being something a caller can assert about a file.
//
// It is therefore the fallback for EVERY type: an SVG, a HEIC photo, a
// PowerPoint deck and an unknown blob all arrive here and all save correctly,
// under the sanitised filename off the row.
//
// ACCESS IS THE TICKET'S ACCESS, DELIBERATELY REUSED — resolved by
// loadAttachmentForTicket (../_helpers), shared with the preview route so the
// two can never disagree about who may read `accounts@`. Every refusal is a
// 404, never a 403.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { signedAttachmentUrl } from '@/lib/email-attachments-server'
import { loadAttachmentForTicket } from '../_helpers'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Long enough to click and download a large file on a bad connection, short
// enough that a URL copied out of a network tab is worthless by the time
// anyone reads it.
const SIGNED_URL_TTL_SECONDS = 300

export async function GET(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const db = createServerClient()

  const loaded = await loadAttachmentForTicket(db, user, params.id, params.attachmentId)
  if (loaded.response) return loaded.response
  const { attachment } = loaded

  const url = await signedAttachmentUrl(db, attachment.storage_path, {
    filename: attachment.filename,
    ttlSeconds: SIGNED_URL_TTL_SECONDS,
  })
  if (!url) {
    // The row says stored but Storage would not sign it — a real fault worth a
    // 500 rather than a 404, because "the file is missing from the bucket" and
    // "you may not have this file" are different problems for an operator.
    return NextResponse.json(
      { success: false, error: 'Could not prepare that file for download.' },
      { status: 500 }
    )
  }

  return NextResponse.json({
    success: true,
    data: {
      url,
      // storage_path is NEVER returned: it is internal addressing, and the
      // signed URL is the only handle a client needs.
      filename: attachment.filename,
      mime_type: attachment.mime_type,
      size_bytes: attachment.size_bytes,
      // No preview hint here on purpose: the thread payload already carries
      // `preview_kind` per attachment, so the UI knows what a chip does before
      // anyone clicks anything. This response stays exactly the shape it was.
      expires_in: SIGNED_URL_TTL_SECONDS,
    },
  })
}
