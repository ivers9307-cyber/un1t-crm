// INTEG-C2b — Stripe wallet top-ups + TU VAT invoices.
//
// A top-up is a ONE-OFF platform charge (plain Checkout on the
// platform Stripe account — NO connected-account params; Connect is
// the events platform's posture, not this one's): the owner picks a
// fixed denomination, pays it PLUS 23% Irish VAT, and the wallet is
// credited the ex-VAT amount via wallet_apply (src/lib/wallet.js, the
// only balance write path). VAT is invoiced at the POINT OF TOP-UP as
// a plain VAT invoice (deliberately NOT voucher/deferred-revenue
// treatment — Richard 2026-07-19); the invoice row (mig 426,
// TU-<serial> number from the platform-wide sequence) is inserted
// 'pending' BEFORE the Checkout Session exists and is flipped to
// 'paid' exactly once by the dedicated /api/webhooks/stripe-wallet
// endpoint.
//
// Idempotency model (money path — be boring):
//   - the pending->paid claim is a single UPDATE guarded on
//     status='pending' (+ it stamps the payment_intent); a replayed
//     checkout.session.completed matches zero rows and is a no-op, so
//     the wallet_apply top-up posts AT MOST ONCE per invoice.
//   - if wallet_apply fails AFTER the claim, we do NOT revert: the
//     invoice stays 'paid' with no matching ledger row and the failure
//     is logged at error level ("paid but not credited") — a loud,
//     queryable state for a human, rather than a silent double-credit
//     risk.
//
// Gates: fixed denomination whitelist (no free-form amounts — unused
// credit expires monthly, so top-ups stay SMALL) and an ACTIVE tier
// pinning (getLocationPlan() non-null). Nothing is pinned today, so
// the whole flow is unreachable = zero behaviour change.
//
// AUTO top-up: wallets.auto_topup_* config columns exist (mig 420) but
// EXECUTION needs a saved payment method, which arrives with the
// Stripe-Billing subscription track. The seam is executeAutoTopup()
// below — a documented stub, deliberately not built here.

import { getStripe } from '@/lib/stripe'
import { getLocationPlan } from '@/lib/plans'
import { applyWalletEntry } from '@/lib/wallet'
import { getAppUrl } from '@/lib/app-url'
import { getLocationBranding } from '@/lib/location-branding'
import { sendEmail } from '@/lib/postmark'
import { logWarn, logError } from '@/lib/log'

// Fixed top-up denominations in EUR cents (server-side whitelist —
// Richard's spec: small on purpose, because unused credit expires at
// the Dublin month end). Kept in ONE place; the route's Zod schema and
// the /settings/billing buttons both import this.
export const TOPUP_DENOMINATIONS_CENTS = Object.freeze([2500, 5000, 10000, 25000])

// Irish standard VAT rate, charged ON TOP of the credited amount:
// pay amount * 1.23 -> wallet credited amount.
export const TOPUP_VAT_RATE_PERCENT = 23

// Stripe's documented MINIMUM for Checkout Session expires_at is 30
// minutes from creation — this is the floor, not a choice.
export const TOPUP_CHECKOUT_EXPIRES_SECONDS = 30 * 60

// The decided selling entity (SAAS4-W0.2): matches how the legal pages
// render it ("Champ Fitness Ltd (trading as UN1T Dublin)").
export const SELLING_ENTITY_NAME = 'Champ Fitness Ltd'
export const SELLING_ENTITY_SUFFIX = '(trading as UN1T Dublin)'

// ── Pure helpers ────────────────────────────────────────────────────

/** Is this amount one of the fixed top-up denominations? */
export function isTopupDenomination(amountCents) {
  return TOPUP_DENOMINATIONS_CENTS.includes(amountCents)
}

/**
 * VAT (23%) on an ex-VAT credit amount, in cents. Math.round =
 * half-up; exact (no rounding at all) for every fixed denomination,
 * kept correct for any integer input as defence in depth.
 */
export function topupVatCents(amountCents) {
  const n = Number(amountCents)
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`topupVatCents: positive integer cents required, got ${amountCents}`)
  }
  return Math.round((n * TOPUP_VAT_RATE_PERCENT) / 100)
}

/** Total the card is charged: credit + VAT, in cents. */
export function topupTotalCents(amountCents) {
  return Number(amountCents) + topupVatCents(amountCents)
}

function euros(cents) {
  return `€${(Number(cents) / 100).toFixed(2)}`
}

function topupError(code, message) {
  const err = new Error(message)
  err.code = code
  return err
}

// ── Create (owner clicks a denomination) ────────────────────────────

/**
 * Start a wallet top-up: validate the denomination + active tier
 * pinning, insert the 'pending' TU invoice (number minted by the mig
 * 426 column DEFAULT), create the Stripe Checkout Session (plain
 * platform charge, hosted page), stamp the session id on the invoice
 * and return the checkout URL.
 *
 * Throws Error with .code:
 *   'invalid_denomination' — not in TOPUP_DENOMINATIONS_CENTS
 *   'not_pinned'           — location has no active tier pinning
 *   'location_not_found'   — no such location (route 404s first;
 *                            belt-and-braces)
 * Stripe/DB errors propagate unchanged (route maps them to 502).
 *
 * @param {object} db - service-role client (route constructs it)
 * @param {{ locationId: string, amountCents: number, userId: string }} p
 * @returns {Promise<{ checkoutUrl: string, invoiceId: string, number: string }>}
 */
export async function createTopup(db, { locationId, amountCents, userId }) {
  if (!isTopupDenomination(amountCents)) {
    throw topupError(
      'invalid_denomination',
      `Top-ups are fixed at ${TOPUP_DENOMINATIONS_CENTS.map(euros).join(' / ')}.`
    )
  }

  // Active tier pinning is the participation gate for the whole
  // billing surface (null = the normal state for every location today).
  const plan = await getLocationPlan(db, locationId)
  if (!plan) {
    throw topupError('not_pinned', 'This location has no active platform plan, so its wallet is not active.')
  }

  const { data: location, error: locErr } = await db
    .from('locations')
    .select('id, name')
    .eq('id', locationId)
    .maybeSingle()
  if (locErr) throw new Error(`createTopup: ${locErr.message}`)
  if (!location) throw topupError('location_not_found', 'Location not found.')

  const vatCents = topupVatCents(amountCents)
  const totalCents = amountCents + vatCents

  // Insert the pending invoice FIRST so the TU number exists to show on
  // the Checkout line item. amount/vat/total are pinned by the table
  // CHECK (total = amount + vat) as well as the math above.
  const { data: invoice, error: insErr } = await db
    .from('wallet_topup_invoices')
    .insert({
      location_id: locationId,
      amount_cents: amountCents,
      vat_cents: vatCents,
      total_cents: totalCents,
      currency: 'EUR',
      status: 'pending',
      created_by: userId || null,
    })
    .select('id, number')
    .single()
  if (insErr || !invoice) throw new Error(`createTopup: invoice insert failed: ${insErr?.message || 'no row'}`)

  const appUrl = getAppUrl() // throws if unset — no silent fallback

  let session
  try {
    // Hosted Checkout (session.url), NOT the events platform's embedded
    // ui_mode — hosted mode is what supports success_url/cancel_url.
    // ONE line item at the VAT-inclusive total, with the net/VAT split
    // spelled out in the description (Checkout is not our VAT invoice;
    // the TU email/row is).
    session = await getStripe().checkout.sessions.create({
      mode: 'payment',
      line_items: [{
        price_data: {
          currency: 'eur',
          product_data: {
            name: `Wallet top-up — ${location.name}`,
            description:
              `${euros(amountCents)} wallet credit + ${euros(vatCents)} VAT (${TOPUP_VAT_RATE_PERCENT}%). ` +
              `Invoice ${invoice.number}. Credit expires at the end of the billing month.`,
          },
          unit_amount: totalCents,
        },
        quantity: 1,
      }],
      metadata: { invoice_id: invoice.id, location_id: locationId },
      success_url: `${appUrl}/settings/billing?topup=success`,
      cancel_url: `${appUrl}/settings/billing?topup=cancelled`,
      expires_at: Math.floor(Date.now() / 1000) + TOPUP_CHECKOUT_EXPIRES_SECONDS,
    })
  } catch (e) {
    // Best-effort: park the invoice as 'failed' so a dead pending row
    // doesn't linger; the failure itself propagates to the route.
    try {
      await db
        .from('wallet_topup_invoices')
        .update({ status: 'failed' })
        .eq('id', invoice.id)
        .eq('status', 'pending')
    } catch (markErr) {
      logWarn('wallet-topup', 'could not mark invoice failed after Stripe error', {
        err: markErr, invoiceId: invoice.id,
      })
    }
    throw e
  }

  // Stamp the session id — the webhook's primary lookup key. If this
  // write fails the metadata.invoice_id fallback in fulfillTopup still
  // finds the row, so log loudly and continue rather than aborting a
  // session the buyer may already be opening.
  const { error: stampErr } = await db
    .from('wallet_topup_invoices')
    .update({ stripe_checkout_session_id: session.id })
    .eq('id', invoice.id)
  if (stampErr) {
    logError('wallet-topup', 'failed to stamp checkout session id on invoice', {
      err: stampErr, invoiceId: invoice.id, sessionId: session.id,
    })
  }

  return { checkoutUrl: session.url, invoiceId: invoice.id, number: invoice.number }
}

// ── Fulfil (webhook: checkout.session.completed) ────────────────────

// Resolve the invoice a Checkout Session belongs to: primary key is
// the stamped session id; fallback is metadata.invoice_id (covers the
// stamp write failing in createTopup). The fallback VERIFIES the row
// isn't already bound to a DIFFERENT session before trusting it.
async function findInvoiceForSession(db, session) {
  const { data: bySession, error: e1 } = await db
    .from('wallet_topup_invoices')
    .select('*')
    .eq('stripe_checkout_session_id', session.id)
    .maybeSingle()
  if (e1) throw new Error(`wallet-topup lookup: ${e1.message}`)
  if (bySession) return bySession

  const invoiceId = session.metadata?.invoice_id
  if (!invoiceId) return null
  const { data: byId, error: e2 } = await db
    .from('wallet_topup_invoices')
    .select('*')
    .eq('id', invoiceId)
    .maybeSingle()
  if (e2) throw new Error(`wallet-topup lookup: ${e2.message}`)
  if (byId && byId.stripe_checkout_session_id && byId.stripe_checkout_session_id !== session.id) {
    logError('wallet-topup', 'metadata invoice bound to a different session — refusing to fulfil', {
      invoiceId, sessionId: session.id, boundSessionId: byId.stripe_checkout_session_id,
    })
    return null
  }
  return byId || null
}

/**
 * Fulfil a paid top-up session (called by /api/webhooks/stripe-wallet
 * on checkout.session.completed). Idempotent: the pending->paid claim
 * UPDATE is guarded on status='pending', so a replayed webhook (or a
 * concurrent duplicate delivery) matches zero rows and is a no-op —
 * the wallet is credited exactly once. After the claim: wallet_apply
 * kind='topup' amount=amount_cents invoice_ref=number, then a
 * fire-and-forget VAT-invoice email to the acting user.
 *
 * @param {object} db - service-role client
 * @param {object} session - the Stripe Checkout Session object
 * @returns {Promise<{ applied: boolean, reason?: string, invoiceId?: string, newBalanceCents?: number }>}
 */
export async function fulfillTopup(db, session) {
  // checkout.session.completed fires with payment_status 'unpaid' for
  // async payment methods — never credit on a promise to pay. (Cards,
  // the only method we enable, complete as 'paid'.)
  if (session.payment_status && session.payment_status !== 'paid') {
    logWarn('wallet-topup', 'completed session not paid — skipping fulfilment', {
      sessionId: session.id, paymentStatus: session.payment_status,
    })
    return { applied: false, reason: 'not_paid' }
  }

  const invoice = await findInvoiceForSession(db, session)
  if (!invoice) {
    // A paid session with no invoice row is an anomaly worth a loud log
    // (the webhook still 200s — Stripe retries can't fix a missing row).
    logError('wallet-topup', 'no invoice found for completed session', { sessionId: session.id })
    return { applied: false, reason: 'no_invoice' }
  }
  if (invoice.status === 'paid') {
    return { applied: false, reason: 'already_paid', invoiceId: invoice.id }
  }
  if (invoice.status !== 'pending') {
    // 'expired'/'failed' should be unreachable for a session that
    // completed — refuse to credit and flag for a human.
    logError('wallet-topup', `completed session hit a ${invoice.status} invoice — not crediting`, {
      sessionId: session.id, invoiceId: invoice.id, status: invoice.status,
    })
    return { applied: false, reason: `invoice_${invoice.status}`, invoiceId: invoice.id }
  }

  const paymentIntentId =
    typeof session.payment_intent === 'string'
      ? session.payment_intent
      : session.payment_intent?.id || null

  // THE idempotency lock: claim pending->paid in one guarded UPDATE.
  // Zero rows back = another delivery already claimed it = no-op.
  const { data: claimed, error: claimErr } = await db
    .from('wallet_topup_invoices')
    .update({
      status: 'paid',
      paid_at: new Date().toISOString(),
      stripe_payment_intent_id: paymentIntentId,
      stripe_checkout_session_id: session.id,
    })
    .eq('id', invoice.id)
    .eq('status', 'pending')
    .select('id')
  if (claimErr) throw new Error(`fulfillTopup: claim failed: ${claimErr.message}`)
  if (!claimed || claimed.length === 0) {
    return { applied: false, reason: 'already_claimed', invoiceId: invoice.id }
  }

  // Credit the wallet. On failure we deliberately do NOT revert the
  // claim (see module header): loud error + a queryable "paid but no
  // ledger row" state beats any risk of a double credit.
  let newBalanceCents
  try {
    newBalanceCents = await applyWalletEntry(db, {
      locationId: invoice.location_id,
      kind: 'topup',
      amountCents: invoice.amount_cents,
      invoiceRef: invoice.number,
      note: 'Stripe top-up',
      createdBy: invoice.created_by || null,
    })
  } catch (e) {
    logError('wallet-topup', 'INVOICE PAID BUT WALLET NOT CREDITED — apply wallet_apply topup manually', {
      err: e,
      invoiceId: invoice.id,
      number: invoice.number,
      locationId: invoice.location_id,
      amountCents: invoice.amount_cents,
    })
    return { applied: false, reason: 'credit_failed', invoiceId: invoice.id }
  }

  // Fire-and-forget VAT-invoice email — never blocks or fails the
  // fulfilment (repo convention for post-write side effects).
  try {
    await sendTopupInvoiceEmail(db, { ...invoice, status: 'paid', paid_at: new Date().toISOString() })
  } catch (e) {
    logWarn('wallet-topup', 'VAT invoice email failed', { err: e, invoiceId: invoice.id })
  }

  return { applied: true, invoiceId: invoice.id, newBalanceCents }
}

// ── Expire (webhook: checkout.session.expired) ──────────────────────

/**
 * Mark a top-up invoice 'expired' when its Checkout Session expires
 * (30-minute window, never paid). Guarded on status='pending' so a
 * replay — or an expiry racing a completion — can never regress a paid
 * invoice.
 *
 * @returns {Promise<{ expired: boolean }>}
 */
export async function markTopupSessionExpired(db, session) {
  const invoice = await findInvoiceForSession(db, session)
  if (!invoice) return { expired: false }
  const { data, error } = await db
    .from('wallet_topup_invoices')
    .update({ status: 'expired' })
    .eq('id', invoice.id)
    .eq('status', 'pending')
    .select('id')
  if (error) throw new Error(`markTopupSessionExpired: ${error.message}`)
  return { expired: !!(data && data.length) }
}

// ── VAT invoice email ───────────────────────────────────────────────

/**
 * Pure renderer for the TU VAT invoice email — exported for tests.
 * Plain, clean invoice: number, date, location, net/VAT/total, issuer
 * Champ Fitness Ltd (the decided selling entity, rendered the way the
 * legal pages render it). Branding header mirrors
 * contractor-invoice-email.js (logo when configured, name fallback).
 *
 * @returns {{ subject: string, htmlBody: string, textBody: string }}
 */
export function renderTopupInvoiceEmail({ invoice, locationName, branding, recipientName }) {
  const dateLabel = new Intl.DateTimeFormat('en-IE', {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Dublin',
  }).format(new Date(invoice.paid_at || invoice.created_at || Date.now()))

  const header = branding?.logoUrl
    ? `<img src="${escapeAttr(branding.logoUrl)}" alt="${escapeAttr(branding.companyName || 'Logo')}" style="max-height:48px;margin-bottom:16px" />`
    : `<div style="font-size:24px;font-weight:bold;letter-spacing:2px;margin-bottom:16px">${escapeHtml(branding?.companyName || 'UN1T')}</div>`

  const subject = `VAT invoice ${invoice.number}: wallet top-up for ${locationName}`
  const htmlBody = `
    <div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:600px">
      ${header}
      <div style="font-size:18px;font-weight:bold;margin-bottom:4px">VAT invoice</div>
      <div style="color:#666;font-size:13px;margin-bottom:24px">
        Issued by ${escapeHtml(SELLING_ENTITY_NAME)} ${escapeHtml(SELLING_ENTITY_SUFFIX)}
      </div>
      <p>Hi ${escapeHtml(recipientName || 'there')},</p>
      <p>Thanks for topping up the usage wallet for <strong>${escapeHtml(locationName)}</strong>.
      Your payment has been received and the credit is on the wallet now.</p>
      <table style="border-collapse:collapse;margin:16px 0">
        <tr><td style="padding:4px 12px 4px 0;color:#666">Invoice number</td><td style="padding:4px 0">${escapeHtml(invoice.number)}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#666">Date</td><td style="padding:4px 0">${escapeHtml(dateLabel)}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#666">Location</td><td style="padding:4px 0">${escapeHtml(locationName)}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#666">Wallet credit (net)</td><td style="padding:4px 0">${euros(invoice.amount_cents)}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#666">VAT (${TOPUP_VAT_RATE_PERCENT}%)</td><td style="padding:4px 0">${euros(invoice.vat_cents)}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#666"><strong>Total paid</strong></td><td style="padding:4px 0"><strong>${euros(invoice.total_cents)}</strong></td></tr>
      </table>
      <p style="color:#666;font-size:13px">
        Wallet credit is a monthly usage budget and unused credit expires at the end of the
        billing month. Keep this invoice for your VAT records.
      </p>
      <p style="color:#666;font-size:13px;margin-top:24px">
        ${escapeHtml(SELLING_ENTITY_NAME)} ${escapeHtml(SELLING_ENTITY_SUFFIX)}
      </p>
    </div>
  `.trim()
  const textBody =
    `VAT invoice ${invoice.number}\n` +
    `Issued by ${SELLING_ENTITY_NAME} ${SELLING_ENTITY_SUFFIX}\n\n` +
    `Hi ${recipientName || 'there'},\n\n` +
    `Thanks for topping up the usage wallet for ${locationName}. ` +
    `Your payment has been received and the credit is on the wallet now.\n\n` +
    `Invoice number: ${invoice.number}\n` +
    `Date: ${dateLabel}\n` +
    `Location: ${locationName}\n` +
    `Wallet credit (net): ${euros(invoice.amount_cents)}\n` +
    `VAT (${TOPUP_VAT_RATE_PERCENT}%): ${euros(invoice.vat_cents)}\n` +
    `Total paid: ${euros(invoice.total_cents)}\n\n` +
    `Wallet credit is a monthly usage budget and unused credit expires at the end of the billing month. ` +
    `Keep this invoice for your VAT records.\n`

  return { subject, htmlBody, textBody }
}

// Send the VAT invoice to the acting user (invoice.created_by ->
// profiles.email). Best-effort: throws propagate to the caller's own
// try/catch (fulfillTopup swallows + logs).
async function sendTopupInvoiceEmail(db, invoice) {
  if (!invoice.created_by) {
    logWarn('wallet-topup', 'invoice has no created_by — skipping VAT email', { invoiceId: invoice.id })
    return { skipped: true }
  }
  const [{ data: profile }, { data: location }] = await Promise.all([
    db.from('profiles').select('email, full_name').eq('id', invoice.created_by).maybeSingle(),
    db.from('locations').select('name').eq('id', invoice.location_id).maybeSingle(),
  ])
  if (!profile?.email) {
    logWarn('wallet-topup', 'acting user has no email — skipping VAT email', { invoiceId: invoice.id })
    return { skipped: true }
  }
  // Branding never throws (falls back to a neutral 'UN1T') — same
  // resolution the contractor invoice emails use (company_settings).
  const branding = await getLocationBranding(db, invoice.location_id)
  const locationName = location?.name || 'your location'
  const { subject, htmlBody, textBody } = renderTopupInvoiceEmail({
    invoice, locationName, branding, recipientName: profile.full_name,
  })
  return sendEmail({
    to: profile.email,
    subject,
    htmlBody,
    textBody,
    stream: 'outbound', // Postmark transactional stream
    tag: 'wallet-topup-invoice',
    metadata: { invoice_id: invoice.id, location_id: invoice.location_id },
  })
}

// ── Auto top-up seam (NOT built — Stripe-Billing track) ─────────────
//
// wallets.auto_topup_enabled / _amount_cents / _threshold_cents (mig
// 420, configured via PATCH /api/settings/billing/auto-topup) describe
// WHEN an automatic top-up should fire. Executing one requires an
// off-session charge on a SAVED payment method, which only exists once
// the Stripe-Billing subscription work lands (customer + default
// payment method on file). When that track ships, implement it here:
// read the config, create the pending TU invoice exactly like
// createTopup, then confirm a PaymentIntent with
// { customer, payment_method, off_session: true } instead of a
// Checkout Session, and reuse fulfillTopup's claim + wallet_apply +
// email path keyed on the PaymentIntent webhook. Deliberately a
// comment, not code — nothing here should half-work.

function escapeHtml(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;')
}
function escapeAttr(s) {
  return escapeHtml(s)
}
