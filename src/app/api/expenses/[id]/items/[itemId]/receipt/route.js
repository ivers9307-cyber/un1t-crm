// FTE-EXPENSES.1 — GET /api/expenses/[id]/items/[itemId]/receipt
//
// Returns a 5-minute signed URL for the receipt PDF/image in the
// fte-expense-receipts storage bucket. Visible to the submitter +
// owner-at-location + master.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const STORAGE_BUCKET = 'fte-expense-receipts'
const SIGNED_URL_TTL_SECONDS = 300

function canRead(user, claim) {
  if (user.profileRole === 'master' || user.role === 'master') return true
  if (claim.profile_id === user.id) return true
  return Object.entries(user.rolesByLocation || {})
    .some(([loc, r]) => r === 'owner' && loc === claim.location_id)
}

export async function GET(_request, { params }) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  const { id: claimId, itemId } = await params

  const db = createServerClient()
  const { data: item } = await db
    .from('fte_expense_items')
    .select(`
      id, receipt_path, receipt_mime_type,
      claim:claim_id ( id, profile_id, location_id )
    `)
    .eq('id', itemId)
    .eq('claim_id', claimId)
    .maybeSingle()
  if (!item) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  if (!canRead(user, item.claim)) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
  if (!item.receipt_path) {
    return NextResponse.json({ success: false, error: 'No receipt uploaded for this item.' }, { status: 404 })
  }

  const { data: signed, error } = await db.storage
    .from(STORAGE_BUCKET)
    .createSignedUrl(item.receipt_path, SIGNED_URL_TTL_SECONDS)
  if (error || !signed?.signedUrl) {
    return NextResponse.json({ success: false, error: error?.message || 'Could not sign URL.' }, { status: 500 })
  }

  return NextResponse.json({
    success: true,
    url: signed.signedUrl,
    expires_in: SIGNED_URL_TTL_SECONDS,
    mime_type: item.receipt_mime_type,
  })
}
