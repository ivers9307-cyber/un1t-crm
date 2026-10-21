// PAIDTRIAL.1 — payment lifecycle for a paid trial purchase (trial_purchases).
//
// Mirrors class-booking-payments.js (the paid class-funnel intro): the public
// route inserts the row `awaiting_payment`, createTrialPurchasePayment() opens
// a provider order and stamps the refs; the signed webhook or the status
// route's provider re-check calls markTrialPurchasePaymentStatus(): 'paid'
// RELEASES the row (status → 'queued') for the processor to put the Glofox
// plan on the account; failed/cancelled/expired are terminal, no money taken.
import { paymentsFor } from './payments'
import { resolveLocationPaymentProvider } from './location-payments'
import { resolveCustomerBaseUrl } from './tenant-host'
import { getLocationBranding } from './location-branding'

/** "UN1T Stillorgan: 2 Week Trial" on the checkout and the statement. */
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

/** Webhook lookup: the row that owns this provider order (null when none). */
export async function resolveTrialPurchaseByRef(db, providerRef) {
  if (!providerRef) return null
  const { data } = await db.from('trial_purchases').select('*').eq('payment_provider_ref', providerRef).maybeSingle()
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
  if (state === 'failed' || state === 'cancelled' || state === 'expired') {
    const payment_status = state === 'cancelled' ? 'expired' : state
    const { error } = await db.from('trial_purchases').update({ payment_status, status: 'payment_failed' }).eq('id', purchase.id)
    if (error) throw error
    return { released: false }
  }
  return { released: false }
}
