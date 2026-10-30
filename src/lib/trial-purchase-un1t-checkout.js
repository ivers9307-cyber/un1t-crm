// TRIALSTUDIO.6 — the Hatch Street leg of POST /api/public/trial-purchases.
//
// The CRM never charges a Hatch buyer: it finds or creates the buyer's
// un1t.online account (ensureUn1tAccount) and asks un1t.online for its own
// hosted checkout (createCheckoutLink); un1t.online takes the money and puts
// the product on the account. Never POST /purchases/charge, never POST
// /credits/grant for this product.
//
// The trial_purchases row is already inserted (awaiting_payment, carrying the
// terms acceptance ensureUn1tAccount reads). This module stamps it and judges
// every outcome:
//   - account found or created → un1t_user_id stamped BEFORE the checkout (the
//     sweeper settles on it; a row it cannot settle is never sent to pay);
//   - checkout made → un1t_ledger_id stamped; the URL goes back to the browser
//     once and is never stored on the row or logged;
//   - a budget / throttle answer, or a settings read that failed (nothing
//     sent) → row `failed` with the code; the caller answers 503;
//   - a refusal or an unclear answer → row `help_requested` with
//     `un1t_account_refused: <reason>` / `un1t_checkout_refused: <code>` /
//     `un1t_outcome_unknown: <code>`, and the staff alert;
//   - that help stamp refused 23505 by uniq_trial_purchases_open_help (mig
//     764: the buyer already has an open help card at this studio) → row
//     `failed` with `help_card_already_open`, NO second alert (the open card
//     is staff's already), and still help_filed for the buyer.
// Logs carry ids and codes only, never the raw error (a PostgREST error's
// details can name the row's email and phone).
import { ensureUn1tAccount } from '@/lib/un1t-online-account'
import { createCheckoutLink } from '@/lib/un1t-online-write-ops'
import { Un1tWriteRefused, Un1tWriteUnknown } from '@/lib/un1t-online-write'
import { Un1tSettingsReadError } from '@/lib/un1t-online-settings'
import { resolveCustomerBaseUrl } from '@/lib/tenant-host'
import { alertTrialPurchaseStaff } from '@/lib/trial-purchase-processor'
import { logWarn, logError } from '@/lib/log'

const LOG = 'trialbuy'
export const UN1T_TRIAL_ORIGIN = 'web_trial'

/**
 * @param {object} db service-role client
 * @param {{ row: object, location: { id: string, organization_id: string|null },
 *   contact: { id: string, email: string, first_name?: string|null, last_name?: string|null,
 *   name?: string|null, phone?: string|null, un1t_user_id?: string|null },
 *   returnPath?: string }} args returnPath: the page the buyer started on
 *   (already allowlisted by the caller, see trial-return-path.js); default /trial
 * @returns {Promise<{ kind: 'redirect', checkoutUrl: string } | { kind: 'help_filed' } | { kind: 'unavailable' }>}
 */
export async function startUn1tTrialCheckout(db, { row, location, contact, returnPath = '/trial' }) {
  const locationId = row.location_id
  const purchaseId = row.id

  const stamp = async (patch) => {
    const { error } = await db.from('trial_purchases').update(patch).eq('id', purchaseId).eq('location_id', locationId)
    return error || null
  }

  // For the sweeper (Task 7): if one of these terminal stamps fails after the
  // un1t_user_id stamp, the row stays awaiting_payment WITH a un1t_user_id and
  // is settleable, so the sweeper must match each un1t.online purchase to at
  // most one row (a buyer's retry makes a second row for the same user).
  const failed = async (code) => {
    const err = await stamp({ status: 'failed', last_error: code })
    if (err) logError(LOG, 'un1t trial row not marked failed', { purchaseId, locationId, lastError: code, code: err.code ?? null })
    return { kind: 'unavailable' }
  }

  const help = async (reason, detail, extra = {}) => {
    const last_error = `${reason}: ${detail}`
    const err = await stamp({ status: 'help_requested', last_error, ...extra })
    // An open help card for this buyer here already (uniq_trial_purchases_open_help):
    // close this row out and leave the alert to that card.
    if (err?.code === '23505') {
      const closeErr = await stamp({ status: 'failed', last_error: 'help_card_already_open', ...extra })
      if (closeErr) logError(LOG, 'un1t trial row not closed beside the open help card', { purchaseId, locationId, code: closeErr.code ?? null })
      else logWarn(LOG, 'help card already open for this buyer; no second alert', { purchaseId, locationId, lastError: last_error })
      return { kind: 'help_filed' }
    }
    // The alert still goes: staff hear about the buyer even if the card is missing.
    if (err) logError(LOG, 'un1t trial row not filed for help', { purchaseId, locationId, lastError: last_error, code: err.code ?? null })
    try {
      await alertTrialPurchaseStaff(db, { ...row, ...extra, status: 'help_requested', last_error }, reason, detail)
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
      request: row, origin: UN1T_TRIAL_ORIGIN, originRef: purchaseId, actor: null,
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

  // ── 2. un1t.online's hosted checkout, back to the page the buyer started on, on the customer host ──
  const base = await resolveCustomerBaseUrl(db, locationId)
  const successUrl = `${base}${returnPath}?purchase=${encodeURIComponent(purchaseId)}&studio=hatch`
  const cancelUrl = `${successUrl}&cancelled=1`
  let checkout
  try {
    checkout = await createCheckoutLink(db, {
      locationId, userId: account.un1tUserId, productId: row.un1t_product_id,
      successUrl, cancelUrl, idempotencyKey: `trial_purchase:${purchaseId}`,
      origin: UN1T_TRIAL_ORIGIN, originRef: purchaseId, actor: null,
    })
  } catch (err) {
    if (err instanceof Un1tSettingsReadError) return failed(err.code || 'un1t_settings_unreadable')
    if (err instanceof Un1tWriteRefused) {
      return err.result?.retryable ? failed(err.code) : help('un1t_checkout_refused', err.code)
    }
    if (err instanceof Un1tWriteUnknown) {
      return help('un1t_outcome_unknown', err.code || 'outcome_unknown', err.ledgerId ? { un1t_ledger_id: err.ledgerId } : {})
    }
    logError(LOG, 'un1t checkout threw', { purchaseId, locationId, code: err?.code ?? null, errClass: err?.name })
    return help('un1t_outcome_unknown', 'checkout_error')
  }

  const ledger = checkout?.ledgerId ? { un1t_ledger_id: checkout.ledgerId } : {}
  // A "free" answer has no page to send the buyer to; staff check the account.
  if (checkout?.free === true || typeof checkout?.checkoutUrl !== 'string' || !checkout.checkoutUrl) {
    return help('un1t_outcome_unknown', checkout?.free === true ? 'checkout_free' : 'checkout_no_url', ledger)
  }
  if (checkout.ledgerId) {
    const ledgerErr = await stamp(ledger)
    // The sweeper settles on un1t_user_id; a missing ledger link is logged, not fatal.
    if (ledgerErr) logWarn(LOG, 'un1t ledger id not stamped', { purchaseId, locationId, ledgerId: checkout.ledgerId, code: ledgerErr.code ?? null })
  }
  return { kind: 'redirect', checkoutUrl: checkout.checkoutUrl }
}
