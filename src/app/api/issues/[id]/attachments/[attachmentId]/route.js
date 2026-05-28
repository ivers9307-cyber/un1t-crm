// REPORT-ISSUE.1 — signed-URL fetch for an issue attachment.
//
// Bucket is private (deny-all RLS on storage.objects). We mint a
// short-lived signed URL with the service-role client so the UI
// can render the image. Same pattern as the FTE-expense receipt
// endpoint.
//
// Scope: PR 1 only lets the submitter view their own issue's
// attachments. PR 2 extends this to handlers at the location.

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// 10 min is enough for the UI to load the image and then some.
// Long enough to survive a slow 4G round-trip; short enough to
// prevent the URL being shared in a useful way if it leaks.
const SIGNED_URL_TTL_SECONDS = 600

export const GET = withAuth(
  {},
  async ({ user, db, params }) => {
    const issueId = params?.id
    const attachmentId = params?.attachmentId
    if (!issueId || !attachmentId) {
      return NextResponse.json(
        { success: false, error: 'Issue id + attachment id required.' },
        { status: 400 }
      )
    }

    // Verify ownership at the JOIN — fetch the attachment WITH its
    // parent issue, gated on submitter_id = caller. Anything else
    // returns 404 so we don't leak.
    const { data: row } = await db
      .from('issue_attachments')
      .select(`
        id, storage_path, bucket, mime_type,
        issues:issue_id ( id, submitter_id )
      `)
      .eq('id', attachmentId)
      .eq('issue_id', issueId)
      .maybeSingle()

    if (!row || row.issues?.submitter_id !== user.id) {
      return NextResponse.json(
        { success: false, error: 'Attachment not found.' },
        { status: 404 }
      )
    }

    const { data: signed, error } = await db.storage
      .from(row.bucket || 'issue-photos')
      .createSignedUrl(row.storage_path, SIGNED_URL_TTL_SECONDS)

    if (error || !signed?.signedUrl) {
      return NextResponse.json(
        { success: false, error: error?.message || 'Could not sign URL.' },
        { status: 500 }
      )
    }

    return NextResponse.json({
      success: true,
      data: {
        url: signed.signedUrl,
        expires_in: SIGNED_URL_TTL_SECONDS,
        mime_type: row.mime_type,
      },
    })
  }
)
