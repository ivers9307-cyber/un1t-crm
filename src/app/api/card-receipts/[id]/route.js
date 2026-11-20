// GET /api/card-receipts/[id]
//
// Detail for one company-card receipt. Visible to the submitter (own)
// or an owner/master at the receipt's location (the approver). Returns
// 404 — not 403 — on no-access so ids can't be enumerated (IDOR posture
// per the repo's service-role-route lesson).

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { logError } from '@/lib/log'

export const runtime = 'nodejs'

// withAuth only signs the caller in; who may see the row (its submitter, or an
// owner/master at its studio) is judged on the row below, 404 otherwise.
export const GET = withAuth({ permission: null, location: false }, async ({ user, db, params }) => {
  const { data: rec, error } = await db
    .from('card_receipts')
    .select(`
      id, status, location_id, submitter_id, purchase_date, amount, vat_amount,
      merchant, description, card_last4, notes, receipt_mime_type,
      submitted_at, reviewed_at, approved_at, declined_at, revoked_at, decline_reason,
      submitter:submitter_id ( id, full_name, email ),
      location:location_id ( id, name ),
      reviewer:reviewed_by ( id, full_name )
    `)
    .eq('id', params.id)
    .maybeSingle()
  if (error) {
    logError('card-receipts', 'receipt read failed', { receiptId: params.id, err: error })
    return NextResponse.json({ success: false, error: 'Could not load the receipt.' }, { status: 400 })
  }
  if (!rec) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })

  const isSubmitter = rec.submitter_id === user.id
  const ownerLocations = Object.entries(user.rolesByLocation || {})
    .filter(([, r]) => r === 'owner').map(([loc]) => loc)
  const isApprover = user.role === 'master' || ownerLocations.includes(rec.location_id)
  if (!isSubmitter && !isApprover) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }

  // Tell the client which actions this viewer may take, so the UI
  // doesn't have to re-derive the role rules.
  const viewer_role = isApprover ? (user.role === 'master' ? 'master' : 'owner') : 'submitter'
  return NextResponse.json({ success: true, data: { ...rec, viewer_role } })
})
