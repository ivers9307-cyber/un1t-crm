// GET /api/public/offer-purchases/[id] — public, read-only paid-status of one
// offer purchase for the checkout page to poll (OFFERS.4). Returns only
// { paid, state } — no buyer PII. While the row is still 'created' it
// re-checks Revolut directly (rate-capped) so the UI can advance before the
// webhook lands; a flip to paid runs the same fire-and-forget side effects
// the webhook would (marking is idempotent, so exactly one path runs them).
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getOrder } from '@/lib/revolut'
import {
  markOfferPurchaseState,
  linkOrCreateContactForPurchase,
  notifyStaffOfPaidPurchase,
} from '@/lib/sale-offers'
import { sendOfferPurchaseEmail } from '@/lib/offer-purchase-emails'
import { checkRateLimit } from '@/lib/rate-limit'
import { logWarn } from '@/lib/log'

export const runtime = 'nodejs'

export async function GET(_request, props) {
  const { id } = await props.params
  const db = createServerClient()

  const { data: row } = await db
    .from('offer_purchases')
    .select('id, state, revolut_order_id, location_id, buyer_name, buyer_email, buyer_phone, amount_cents, offer:offer_id ( id, name, bonus_headline, category )')
    .eq('id', id)
    .maybeSingle()
  if (!row) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })

  let current = row
  if (row.state === 'created' && row.revolut_order_id) {
    const recheck = await checkRateLimit(db, `offerpoll:${id}`, { max: 20, windowMs: 5 * 60_000 })
    if (recheck.allowed) {
      try {
        const order = await getOrder(row.revolut_order_id)
        const state = String(order?.state || '').toLowerCase()
        const { changed, state: next } = await markOfferPurchaseState({ db, purchase: row, providerState: state })
        if (changed) current = { ...row, state: next }
        if (changed && next === 'paid') {
          try {
            const { contactId } = await linkOrCreateContactForPurchase(db, row)
            await notifyStaffOfPaidPurchase(db, row, row.offer || {})
            await sendOfferPurchaseEmail(db, {
              purchase: { ...row, contact_id: row.contact_id || contactId || null },
              offer: row.offer || {},
              kind: 'paid',
            })
          } catch (e) {
            logWarn('offer-status', `paid side-effects failed for ${id}`, { err: e })
          }
        }
      } catch (e) {
        logWarn('offer-status', `provider recheck failed for ${id}`, { err: e })
      }
    }
  }

  return NextResponse.json({ success: true, data: { paid: current.state === 'paid', state: current.state } })
}
