// REPORT-ISSUE.2 — signed-URL fetch for an issue attachment, on
// the HANDLER path. Identical to /api/issues/[id]/attachments/[id]
// (PR 1) except the authz check is "is the caller a handler at the
// issue's location" rather than "is the caller the submitter".

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { isIssueHandler } from '@/lib/issues-access'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const SIGNED_URL_TTL_SECONDS = 600

export const GET = withAuth(
  {},
  async ({ user, db, locationId, params }) => {
    if (!isIssueHandler(user)) {
      return NextResponse.json(
        { success: false, error: 'Only issue handlers can read inbox attachments.' },
        { status: 403 }
      )
    }
    const issueId = params?.id
    const attachmentId = params?.attachmentId
    if (!issueId || !attachmentId) {
      return NextResponse.json(
        { success: false, error: 'Issue id + attachment id required.' },
        { status: 400 }
      )
    }

    const { data: row } = await db
      .from('issue_attachments')
      .select(`
        id, storage_path, bucket, mime_type,
        issues:issue_id ( id, location_id )
      `)
      .eq('id', attachmentId)
      .eq('issue_id', issueId)
      .maybeSingle()

    if (!row) {
      return NextResponse.json({ success: false, error: 'Attachment not found.' }, { status: 404 })
    }
    // Non-master handler can only fetch attachments for issues at
    // their active location.
    if (user?.role !== 'master' && !user?.isMaster && locationId && row.issues?.location_id !== locationId) {
      return NextResponse.json({ success: false, error: 'Attachment not found.' }, { status: 404 })
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
