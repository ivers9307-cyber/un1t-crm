// FTE-EXPENSES.1 — GET /api/expenses/[id]/items/[itemId]/receipt
//
// Returns a 5-minute signed URL for the receipt PDF/image in the
// fte-expense-receipts storage bucket. Visible to whoever can see the
// claim (canSeeExpenseClaim: submitter, master, owner or expense approver
// at the claim's studio).

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { logError } from '@/lib/log'
import { canSeeExpenseClaim } from '@/lib/fte-expense-access'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const STORAGE_BUCKET = 'fte-expense-receipts'
const SIGNED_URL_TTL_SECONDS = 300

// withAuth only signs the caller in; who may see the claim is judged on the
// row (canSeeExpenseClaim), a refusal the missing-item 404, as before.
export const GET = withAuth({ permission: null, location: false }, async ({ user, db, params }) => {
  const { id: claimId, itemId } = params || {}
  const { data: item } = await db
    .from('fte_expense_items')
    .select(`
      id, receipt_path, receipt_mime_type,
      claim:claim_id ( id, profile_id, location_id )
    `)
    .eq('id', itemId)
    .eq('claim_id', claimId)
    .maybeSingle()
  // FINALTIDY.1 — a caller who can't see the claim gets the same 404 as a
  // missing item, so ids can't be probed for existence.
  if (!item || !canSeeExpenseClaim(user, item.claim)) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }
  if (!item.receipt_path) {
    return NextResponse.json({ success: false, error: 'No receipt uploaded for this item.' }, { status: 404 })
  }

  const { data: signed, error } = await db.storage
    .from(STORAGE_BUCKET)
    .createSignedUrl(item.receipt_path, SIGNED_URL_TTL_SECONDS)
  if (error || !signed?.signedUrl) {
    if (error) logError('expenses', 'receipt sign failed', { itemId: item.id, err: error })
    return NextResponse.json({ success: false, error: 'Could not sign URL.' }, { status: 500 })
  }

  return NextResponse.json({
    success: true,
    url: signed.signedUrl,
    expires_in: SIGNED_URL_TTL_SECONDS,
    mime_type: item.receipt_mime_type,
  })
})
