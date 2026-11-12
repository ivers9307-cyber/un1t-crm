// BLACKFRIDAY.4 — the Hatch Street leg of POST /api/public/offers/[studio]/[slug]/checkout.
//
// The CRM never charges a Hatch buyer: it finds or creates the buyer's
// un1t.online account (ensureUn1tAccount) and asks un1t.online for its own
// hosted checkout (createCheckoutLink); un1t.online takes the money and puts
// the product on the account. Never POST /purchases/charge, never POST
// /credits/grant. Mirrors trial-purchase-un1t-checkout.js, with one
// difference: the offer_purchases row is inserted HERE (provider
// un1t_online, origin page, state created, carrying the terms acceptance
// ensureUn1tAccount reads).
//
// Every outcome is judged:
//   - account found or created → un1t_user_id stamped BEFORE the checkout (the
//     sweep settles on it; a row it cannot settle is never sent to pay);
//   - checkout made → the URL goes back to the browser once and is never
//     stored on the row or logged;
//   - a settings read that failed, a budget / throttle answer, or a read that
//     threw (nothing sent) → row `failed` with the code; `unavailable` (the
//     caller answers 503 busy and the buyer tries again);
//   - a refusal, an account card or an unclear answer → row `failed` with
//     `un1t_account_refused: <code>` / `un1t_checkout_refused: <code>` /
//     `un1t_outcome_unknown: <code>`, ONE ops alert naming the buyer, and
//     `help_filed`.
// Logs carry ids and codes only, never the raw error (a PostgREST error's
// details can name the row's email and phone).
import { ensureUn1tAccount } from '@/lib/un1t-online-account'
import { createCheckoutLink } from '@/lib/un1t-online-write-ops'
import { Un1tWriteRefused, Un1tWriteUnknown } from '@/lib/un1t-online-write'
import { Un1tSettingsReadError } from '@/lib/un1t-online-settings'
import { resolveCustomerBaseUrl } from '@/lib/tenant-host'
import { sendOpsAlert } from '@/lib/ops-alerts'
import { escapeHtml } from '@/lib/html-escape'
import { oneLine } from '@/lib/sale-offers'
import { logWarn, logError } from '@/lib/log'

const LOG = 'offers'
export const UN1T_OFFER_ORIGIN = 'web_offer'

/**
 * @param {object} db service-role client
 * @param {{ offer: object, location: { id: string, name?: string, organization_id: string|null },
 *   contact: { id: string, email: string, first_name?: string|null, last_name?: string|null,
 *   name?: string|null, phone?: string|null, un1t_user_id?: string|null },
 *   purchaseId: string,
 *   terms: { terms_accepted_at: string, terms_source: string, terms_version: string|null },
 *   buyer: { name: string, email: string, phone: string },
 *   studioKey?: string }} args studioKey: the /offers/<studio> path segment (default hatch-street)
 * @returns {Promise<{ kind: 'redirect', checkoutUrl: string } | { kind: 'help_filed' } | { kind: 'unavailable', code: string }>}
 */
export async function startUn1tOfferCheckout(db, { offer, location, contact, purchaseId, terms, buyer, studioKey = 'hatch-street' }) {
  const locationId = location.id

  // ── 0. The purchase row ──
  const { error: insErr } = await db.from('offer_purchases').insert({
    id: purchaseId,
    offer_id: offer.id,
    location_id: locationId,
    contact_id: contact.id,
    buyer_name: buyer.name,
    buyer_email: buyer.email,
    buyer_phone: buyer.phone,
    amount_cents: offer.price_cents,
    currency: offer.currency,
    payment_provider: 'un1t_online',
    origin: 'page',
    state: 'created',
    un1t_product_id: offer.un1t_product_id,
    terms_accepted_at: terms.terms_accepted_at,
    terms_source: terms.terms_source,
    terms_version: terms.terms_version ?? null,
  })
  if (insErr) {
    logError(LOG, 'un1t offer purchase insert failed', { purchaseId, locationId, offerId: offer.id, code: insErr.code ?? null })
    return { kind: 'unavailable', code: 'purchase_insert_failed' }
  }

  const stamp = async (patch) => {
    const { error } = await db.from('offer_purchases')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('id', purchaseId).eq('location_id', locationId)
    return error || null
  }

  const failed = async (code) => {
    const err = await stamp({ state: 'failed', last_error: code })
    if (err) logError(LOG, 'un1t offer row not marked failed', { purchaseId, locationId, lastError: code, code: err.code ?? null })
    return { kind: 'unavailable', code }
  }

  const help = async (reason, detail, extraLog = {}) => {
    const last_error = `${reason}: ${detail}`
    const err = await stamp({ state: 'failed', last_error })
    // The alert still goes: staff hear about the buyer even if the row stamp is missing.
    if (err) logError(LOG, 'un1t offer row not marked for help', { purchaseId, locationId, lastError: last_error, code: err.code ?? null })
    else logWarn(LOG, 'un1t offer checkout needs staff', { purchaseId, locationId, offerId: offer.id, lastError: last_error, ...extraLog })
    try {
      await sendOpsAlert({
        organizationId: location.organization_id ?? null,
        locationId,
        // BLACKFRIDAY.9 — one line: a stored name can carry a newline.
        subject: `BLACK FRIDAY: ${oneLine(buyer.name)} needs help buying ${oneLine(offer.name)}`,
        htmlBody: `
    <p><strong>${escapeHtml(buyer.name)}</strong> tried to buy <strong>${escapeHtml(offer.name)}</strong> on the offers page, but un1t.online's checkout could not be opened. Nothing was charged.</p>
    <ul>
      <li>Email: ${escapeHtml(buyer.email)}</li>
      <li>Phone: ${escapeHtml(buyer.phone || 'not given')}</li>
      <li>Studio: ${escapeHtml(location.name || locationId)}</li>
      <li>Reason: ${escapeHtml(last_error)}</li>
    </ul>
    <p>Contact them today and sell the offer in un1t.online by hand.</p>`,
        pushBody: `${oneLine(buyer.name)} needs help buying ${oneLine(offer.name)}`,
      }, { db })
    } catch (e) {
      logWarn(LOG, 'staff alert failed', { purchaseId, locationId, code: e?.code ?? null, errClass: e?.name })
    }
    return { kind: 'help_filed' }
  }

  // ── 1. The un1t.online account ──
  let account
  try {
    account = await ensureUn1tAccount(db, {
      locationId, organizationId: location.organization_id ?? null, contact,
      request: {
        terms_accepted_at: terms.terms_accepted_at,
        terms_source: terms.terms_source,
        terms_version: terms.terms_version ?? null,
      },
      origin: UN1T_OFFER_ORIGIN, originRef: purchaseId, actor: null,
    })
  } catch (err) {
    if (err instanceof Un1tSettingsReadError) return failed(err.code || 'un1t_settings_unreadable')
    if (err instanceof Un1tWriteRefused) {
      return err.result?.retryable ? failed(err.code) : help('un1t_account_refused', err.code)
    }
    // A mirror or API read that failed before anything was written: try again.
    logError(LOG, 'un1t account step threw', { purchaseId, locationId, code: err?.code ?? null, errClass: err?.name })
    return failed('un1t_account_unreadable')
  }
  if (account.kind === 'retry') return failed(account.code)
  if (account.kind === 'card') return help('un1t_account_refused', account.reason)

  const userErr = await stamp({ un1t_user_id: account.un1tUserId })
  if (userErr) {
    logError(LOG, 'un1t user id not stamped; no checkout', { purchaseId, locationId, code: userErr.code ?? null })
    return failed('un1t_user_unstamped')
  }

  // ── 2. un1t.online's hosted checkout, back to the offer page on the customer host ──
  const base = await resolveCustomerBaseUrl(db, locationId)
  const successUrl = `${base}/offers/${studioKey}/${encodeURIComponent(offer.slug)}?purchase=${encodeURIComponent(purchaseId)}`
  const cancelUrl = `${successUrl}&cancelled=1`
  let checkout
  try {
    checkout = await createCheckoutLink(db, {
      locationId, userId: account.un1tUserId, productId: offer.un1t_product_id,
      successUrl, cancelUrl, idempotencyKey: `offer_purchase:${purchaseId}`,
      origin: UN1T_OFFER_ORIGIN, originRef: purchaseId, actor: null,
    })
  } catch (err) {
    if (err instanceof Un1tSettingsReadError) return failed(err.code || 'un1t_settings_unreadable')
    if (err instanceof Un1tWriteRefused) {
      return err.result?.retryable ? failed(err.code) : help('un1t_checkout_refused', err.code)
    }
    if (err instanceof Un1tWriteUnknown) {
      return help('un1t_outcome_unknown', err.code || 'outcome_unknown', { ledgerId: err.ledgerId ?? null })
    }
    logError(LOG, 'un1t checkout threw', { purchaseId, locationId, code: err?.code ?? null, errClass: err?.name })
    return help('un1t_outcome_unknown', 'checkout_error')
  }

  // A "free" answer has no page to send the buyer to; staff check the account.
  if (checkout?.free === true || typeof checkout?.checkoutUrl !== 'string' || !checkout.checkoutUrl) {
    return help('un1t_outcome_unknown', checkout?.free === true ? 'checkout_free' : 'checkout_no_url', { ledgerId: checkout?.ledgerId ?? null })
  }
  return { kind: 'redirect', checkoutUrl: checkout.checkoutUrl }
}
