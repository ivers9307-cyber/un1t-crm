// POST /api/offer-purchases/[id]/send-confirmation — send (or re-send) the
// buyer's "you're all set" email for one purchase (OFFERS.11).
//
// The fulfil route sends this automatically. This exists for the two cases it
// cannot cover: purchases fulfilled BEFORE the email existed, and the
// perennial "I never got it" (spam folder, typo'd address later corrected).
//
// Gated on the same per-category approval grant as fulfilment, and 404s on a
// purchase outside the caller's locations so ids can't be enumerated.
import { NextResponse } from 'next/server'
import { getCurrentUser, assertLocationAccessOr404 } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { sendOfferPurchaseEmail } from '@/lib/offer-purchase-emails'

export const runtime = 'nodejs'

export async function POST(_request, props) {
  const { id } = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!hasPermission(user, 'approvals_offer_purchases')) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  const db = createServerClient()
  const { data: row } = await db
    .from('offer_purchases')
    .select('id, state, location_id, contact_id, buyer_name, buyer_email, amount_cents, offer:offer_id ( name, bonus_headline, category )')
    .eq('id', id)
    .maybeSingle()

  if (!row) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  const guard = assertLocationAccessOr404(user, row.location_id)
  if (guard) return guard
  if (row.state !== 'paid') {
    return NextResponse.json({ success: false, error: 'Purchase is not paid' }, { status: 409 })
  }

  // Unlike the fulfil path this is the WHOLE point of the request, so a
  // failure is reported rather than swallowed.
  const result = await sendOfferPurchaseEmail(db, { purchase: row, offer: row.offer || {}, kind: 'ready' })
  if (result.status !== 'sent') {
    return NextResponse.json({ success: false, error: `Not sent: ${result.reason}` }, { status: 409 })
  }
  return NextResponse.json({ success: true, data: { sent: true, to: row.buyer_email } })
}
