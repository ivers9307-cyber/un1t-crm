// GET /api/card-receipts/[id]/receipt
//
// Returns a short-lived (5-min) signed URL for the receipt file in the
// private company-card-receipts bucket. Same access as the detail
// route: submitter (own) or owner/master at the receipt's location.
// 404 on no-access so ids can't be enumerated.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { CARD_RECEIPTS_BUCKET } from '@/lib/card-receipts'

export const runtime = 'nodejs'

const SIGNED_URL_TTL = 300 // 5 minutes

export async function GET(_request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }

  const db = createServerClient()
  const { data: rec, error } = await db
    .from('card_receipts')
    .select('id, location_id, submitter_id, receipt_path, receipt_mime_type')
    .eq('id', params.id)
    .maybeSingle()
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })
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
    return NextResponse.json(
      { success: false, error: `Could not create download URL: ${signErr?.message || 'unknown'}` },
      { status: 500 }
    )
  }

  return NextResponse.json({
    success: true,
    url: data.signedUrl,
    expires_in: SIGNED_URL_TTL,
    mime_type: rec.receipt_mime_type || null,
  })
}
