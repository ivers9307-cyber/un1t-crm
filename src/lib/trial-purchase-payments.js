// PAIDTRIAL.1 — payment lifecycle for a paid trial purchase (trial_purchases).
//
// Mirrors class-booking-payments.js (the paid class-funnel intro): the public
// route inserts the row `awaiting_payment`, createTrialPurchasePayment() opens
// a provider order and stamps the refs; the signed webhook or the status
// route's provider re-check calls markTrialPurchasePaymentStatus(): 'paid'
// RELEASES the row (status → 'queued') for the processor to put the Glofox
// plan on the account; failed/cancelled/expired are terminal, no money taken.
// TRIALLEAK.1 — a trial order lives two hours and the buyer's open checkout is
// handed back rather than re-made (findReusableTrialCheckout).
import { paymentsFor } from './payments'
import { resolveLocationPaymentProvider } from './location-payments'
import { resolveCustomerBaseUrl } from './tenant-host'
import { getLocationBranding } from './location-branding'
import { TRIAL_CHECKOUT_EXPIRE_AFTER, TRIAL_CHECKOUT_REUSE_MS, trialCheckoutUsable, trialPaymentFailure } from './trial-checkout-window'

/** "UN1T Stillorgan: The UN1T 14 Day Reset" on the checkout and the statement. */
export function trialPurchaseDescription(brand, productName) {
  const b = String(brand || '').trim()
  const p = productName || 'trial'
  return b ? `${b}: ${p}` : p
}

/**
 * Open a provider payment for an already-inserted `awaiting_payment` row and
 * persist the provider refs on it. amountCents is the SERVER-derived block
 * price, never a client value. Throws if the ref cannot be persisted (a
 * checkout nothing could ever release must not be handed out).
 */
export async function createTrialPurchasePayment({ db, purchase, location, amountCents, currency, returnPath = '/trial' }) {
  const { provider, connectedAccountId } = resolveLocationPaymentProvider(location)
  const baseUrl = await resolveCustomerBaseUrl(db, location?.id || purchase?.location_id || null)
  const { companyName } = await getLocationBranding(db, location?.id || purchase.location_id)
  const created = await paymentsFor(provider).createPayment({
    amountCents,
    currency: currency || 'EUR',
    description: trialPurchaseDescription(companyName, purchase.product_name),
    // The buyer comes back to the product page, which resumes in confirming
    // mode on ?purchase= (the offers pattern) and polls the status route.
    returnUrl: `${baseUrl}${returnPath}?purchase=${purchase.id}`,
    metadata: { trial_purchase_id: purchase.id, domain: 'un1t_trial_purchase', location_id: purchase.location_id },
    idempotencyKey: purchase.id,
    // REVPAY.7 — buyer, our row id, and what was bought on the statement.
    // TRIALLEAK.1 — two hours, not the 30-minute default: an ad buyer's in-app
    // browser reloads on the way back from their banking app, and the page
    // then resumes this same order (trial-checkout-window.js).
    expirePendingAfter: TRIAL_CHECKOUT_EXPIRE_AFTER,
    customer: { email: purchase.customer_email, fullName: purchase.customer_name },
    merchantReference: `trial:${purchase.id}`,
    statementDescriptorSuffix: 'TRIAL',
    connectedAccountId,
    applicationFeeCents: 0,
  })
  const { error: refErr } = await db.from('trial_purchases')
    .update({
      payment_status: 'pending',
      payment_provider: provider,
      payment_provider_ref: created.providerRef,
      payment_checkout_token: created.checkoutToken || null,
      payment_checkout_url: created.checkoutUrl || null,
      amount_cents: amountCents,
      currency: currency || 'EUR',
      connected_account_id: connectedAccountId || null,
    })
    .eq('id', purchase.id)
  if (refErr) throw new Error(`Failed to persist payment ref for trial purchase ${purchase.id}: ${refErr.message}`)
  return {
    purchaseId: purchase.id,
    checkout: { provider, token: created.checkoutToken || null, url: created.checkoutUrl || null, connectedAccountId },
  }
}

/**
 * TRIALLEAK.1 — the buyer's own open checkout, to hand back instead of opening
 * a second row and a second order when they press pay again: the newest
 * `awaiting_payment` Revolut row of this contact at this studio and page, for
 * the same product and price, whose order is still payable
 * (trialCheckoutUsable). Never a Hatch Street row (its checkout URL is not
 * stored). A failed read is "none" (logged by the caller's choice of a fresh
 * row): reuse is a saving, never a gate.
 * @returns {Promise<{ row: object|null, error: object|null }>}
 */
export async function findReusableTrialCheckout(db, { contactId, locationId, landingPath, pageId = null, membershipId, planCode, amountCents, currency, nowMs = Date.now() }) {
  if (!contactId || !locationId) return { row: null, error: null }
  let q = db.from('trial_purchases').select('*')
    .eq('contact_id', contactId).eq('location_id', locationId).eq('landing_path', landingPath)
    .eq('status', 'awaiting_payment').eq('payment_status', 'pending').eq('payment_provider', 'revolut')
    .eq('membership_id', membershipId).eq('plan_code', planCode)
    .eq('amount_cents', amountCents).eq('currency', currency || 'EUR')
    .gte('created_at', new Date(nowMs - TRIAL_CHECKOUT_REUSE_MS).toISOString())
  q = pageId ? q.eq('page_id', pageId) : q.is('page_id', null)
  // Newest first, one row: 0 rows is the usual answer (maybeSingle).
  const { data, error } = await q.order('created_at', { ascending: false }).limit(1).maybeSingle()
  if (error) return { row: null, error }
  return { row: trialCheckoutUsable(data, nowMs) ? data : null, error: null }
}

/**
 * Webhook lookup: the row that owns this provider order (null when none).
 * REVPAY.1 — `throwOnError`: a failed read throws instead of reading as "no
 * row", so the Revolut webhook can defer rather than drop the payment.
 */
export async function resolveTrialPurchaseByRef(db, providerRef, { throwOnError = false } = {}) {
  if (!providerRef) return null
  const { data, error } = await db.from('trial_purchases').select('*').eq('payment_provider_ref', providerRef).maybeSingle()
  if (error && throwOnError) throw error
  return data || null
}

/**
 * Apply a provider state change. Returns { released } — true when THIS call
 * moved the row from awaiting_payment to queued. Idempotent: a paid row stays
 * paid, a terminal failure stays terminal.
 */
export async function markTrialPurchasePaymentStatus({ db, purchase, providerState, providerAmount, now = () => new Date().toISOString() }) {
  if (purchase?.payment_status === 'paid') return { released: false }
  if (purchase?.payment_status === 'failed' || purchase?.payment_status === 'expired') return { released: false }
  const state = String(providerState || '').toLowerCase()
  if (state === 'completed') {
    const updates = { payment_status: 'paid', paid_at: now() }
    if (Number.isFinite(providerAmount) && providerAmount !== purchase.amount_cents) updates.amount_cents = providerAmount
    if (purchase.status === 'awaiting_payment') updates.status = 'queued'
    const { error } = await db.from('trial_purchases').update(updates).eq('id', purchase.id)
    if (error) throw error
    return { released: updates.status === 'queued' }
  }
  // TRIALLEAK.1 — which it was goes on the row: a checkout that ran out of
  // time (or was cancelled) is `expired` with last_error checkout_expired /
  // checkout_cancelled; a refused payment is `failed` with payment_declined.
  // The status is payment_failed either way, as before.
  const failure = trialPaymentFailure(state, purchase, Date.parse(now()) || Date.now())
  if (failure) {
    const { error } = await db.from('trial_purchases')
      .update({ payment_status: failure.payment_status, status: 'payment_failed', last_error: failure.reason })
      .eq('id', purchase.id)
    if (error) throw error
    return { released: false }
  }
  return { released: false }
}
