// GET /api/card-receipts/[id]/receipt
//
// Returns a short-lived (5-min) signed URL for the receipt file in the
// private company-card-receipts bucket. Same access as the detail
// route: submitter (own) or owner/master at the receipt's location.
// 404 on no-access so ids can't be enumerated.

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { logError } from '@/lib/log'
import { CARD_RECEIPTS_BUCKET } from '@/lib/card-receipts'

export const runtime = 'nodejs'

const SIGNED_URL_TTL = 300 // 5 minutes

// withAuth only signs the caller in; the submitter / owner-at-the-receipt's-
// studio / master checks stay below in their old order (404 on no access).
export const GET = withAuth({ permission: null, location: false }, async ({ user, db, params }) => {
  const { data: rec, error } = await db
    .from('card_receipts')
    .select('id, location_id, submitter_id, receipt_path, receipt_mime_type')
    .eq('id', params?.id)
    .maybeSingle()
  if (error) {
    logError('card-receipts', 'receipt row unreadable', { receiptId: params?.id, code: error.code ?? null })
    return NextResponse.json({ success: false, error: 'Could not load the receipt. Try again.' }, { status: 400 })
  }
  if (!rec) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })

  const isSubmitter = rec.submitter_id === user.id
  const ownerLocations = Object.entries(user.rolesByLocation || {})
    .filter(([, r]) => r === 'owner').map(([loc]) => loc)
  const isApprover = user.role === 'master' || ownerLocations.includes(rec.location_id)
  if (!isSubmitter && !isApprover) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }
  if (!rec.receipt_path) {
    return NextResponse.json({ success: false, error: 'This receipt has no file.' }, { status: 404 })
  }

  const { data, error: signErr } = await db.storage
    .from(CARD_RECEIPTS_BUCKET)
    .createSignedUrl(rec.receipt_path, SIGNED_URL_TTL)
  if (signErr || !data?.signedUrl) {
    logError('card-receipts', 'receipt url not signed', { receiptId: rec.id, err: signErr || null })
    return NextResponse.json({ success: false, error: 'Could not create the download link. Try again.' }, { status: 500 })
  }

  return NextResponse.json({
    success: true,
    url: data.signedUrl,
    expires_in: SIGNED_URL_TTL,
    mime_type: rec.receipt_mime_type || null,
  })
})
