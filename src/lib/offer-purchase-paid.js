// Side effects of an offer purchase that THIS caller just marked paid
// (REVPAY.3). One copy for the three paths that can settle a purchase: the
// signed webhook (/api/webhooks/revolut/offer-payments), the public status
// route's rate-capped recheck (/api/public/offer-purchases/[id]) and the
// reconcile cron (/api/cron/revolut-reconcile). Call it only when
// markOfferPurchaseState returned `{ changed: true, state: 'paid' }`.
//
// Contact link/tag, the staff ops alert, then the buyer receipt. The receipt
// deliberately says "within 24 hours", NOT "it's ready": fulfilment is a
// manual Glofox step that has not happened yet. Throws on a failure so each
// caller logs it under its own module; none of them may fail its response.
import { linkOrCreateContactForPurchase, notifyStaffOfPaidPurchase } from './sale-offers'
import { sendOfferPurchaseEmail } from './offer-purchase-emails'

export async function runOfferPaidSideEffects(db, purchase) {
  const { contactId } = await linkOrCreateContactForPurchase(db, purchase)
  await notifyStaffOfPaidPurchase(db, purchase, purchase.offer || {})
  await sendOfferPurchaseEmail(db, {
    purchase: { ...purchase, contact_id: purchase.contact_id || contactId || null },
    offer: purchase.offer || {},
    kind: 'paid',
  })
}
