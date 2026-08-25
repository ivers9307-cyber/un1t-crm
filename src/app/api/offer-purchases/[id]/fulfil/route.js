// POST /api/offer-purchases/[id]/fulfil — mark a paid sale-offer purchase
// fulfilled (the member has been set up in Glofox) (OFFERS.6).
//
// Gated on the per-category approval grant. Detail-route semantics: an id
// outside the caller's locations returns 404 (not 403) so purchase ids
// can't be enumerated. Idempotent — re-fulfilling returns 200 with
// already: true and leaves the original stamp untouched.
import { NextResponse } from 'next/server'
import { getCurrentUser, assertLocationAccessOr404 } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { sendOfferPurchaseEmail } from '@/lib/offer-purchase-emails'
import { logWarn } from '@/lib/log'

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
    .select('id, state, location_id, fulfilled_at, contact_id, buyer_name, buyer_email, amount_cents, offer:offer_id ( name, bonus_headline, category )')
    .eq('id', id)
    .maybeSingle()

  if (!row) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  const guard = assertLocationAccessOr404(user, row.location_id)
  if (guard) return guard
  if (row.state !== 'paid') {
    return NextResponse.json({ success: false, error: 'Purchase is not paid' }, { status: 409 })
  }
  if (row.fulfilled_at) {
    return NextResponse.json({ success: true, data: { already: true } })
  }

  const { error } = await db
    .from('offer_purchases')
    .update({ fulfilled_at: new Date().toISOString(), fulfilled_by: user.id, updated_at: new Date().toISOString() })
    .eq('id', id)
  if (error) return NextResponse.json({ success: false, error: 'Could not mark fulfilled' }, { status: 500 })

  // Tell the buyer it's live. Fire-and-forget: the fulfilment is recorded
  // either way, and a mail failure must not read as "marking didn't work".
  let emailed = false
  try {
    const r = await sendOfferPurchaseEmail(db, { purchase: row, offer: row.offer || {}, kind: 'ready' })
    emailed = r.status === 'sent'
  } catch (e) {
    logWarn('offer-fulfil', `ready email failed for ${id}`, { err: e })
  }

  return NextResponse.json({ success: true, data: { fulfilled: true, emailed } })
}
