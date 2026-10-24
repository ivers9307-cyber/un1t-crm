// CHARITY.3 — payment lifecycle for a card donation (donations, mig 765).
//
// The public route inserts the row `awaiting_payment`; createDonationPayment()
// opens a provider order and stamps the refs; the signed webhook or the status
// route's provider re-check calls markDonationPaymentStatus(). The processor
// is the EVENT's: resolvePaymentProvider(host), so a donation on a third-party
// host's event is a direct charge on that host's Stripe account and one on a
// UN1T event settles through Revolut. No application fee is taken on a gift.
//
// Status machine: awaiting_payment -> paid | failed | expired, paid ->
// refunded. paid / refunded / failed / expired never change on a replay, and
// every transition is a compare-and-set on the status it left, so two
// concurrent observers cannot both "win".
//
// runPaidDonationSideEffects() runs on EVERY observation of a paid donation,
// not only the one that flipped it, because a side effect that failed once has
// to get another try and a webhook redelivery or the donor's status poll is
// that try. Each step is therefore keyed on its own stamp on the row
// (contact_id, receipt_email_sent_at), never on `changed`, and each stamp is
// written AFTER its effect.

import { paymentsFor } from '@/lib/payments'
import { resolvePaymentProvider, hostCanTakePayments } from '@/lib/event-hosts'
import { getLocationBranding } from '@/lib/location-branding'
import { findOrCreateRaceContact } from '@/lib/race-contact-linking'
import { writeContactTag } from '@/lib/contact-tags'
import { applyFormMarketingConsent } from '@/lib/marketing-consent'
import { emitEvent, EVENT_TYPES } from '@/lib/contact-events'
import { resolveCharitySettings } from '@/lib/charity-donations'
import { sendDonationReceipt } from '@/lib/donation-receipt'
import { logError, logWarn } from '@/lib/log'

const STRIPE_CONNECT = 'stripe_connect'

/** Every donations column the routes select. */
export const DONATION_COLS = [
  'id', 'race_event_id', 'location_id', 'contact_id', 'donor_name', 'donor_email', 'message',
  'amount_cents', 'currency', 'match_multiplier', 'status',
  'payment_provider', 'payment_provider_ref', 'payment_checkout_token', 'payment_checkout_url', 'connected_account_id',
  'paid_at', 'refunded_at', 'refunded_by', 'receipt_email_sent_at', 'receipt_email_status',
  'marketing_opt_in', 'attribution', 'created_at', 'updated_at',
].join(', ')

// paid and refunded never move. failed and expired never move on another
// failure report, but a `completed` report may still follow one (see below).
const IMMOVABLE = new Set(['paid', 'refunded'])
const TERMINAL_FAILURE = new Set(['failed', 'expired'])

/** "UN1T Stillorgan: Donation to MS Ireland" on the checkout and the statement. */
export function donationDescription(brand, charityName) {
  const b = String(brand || '').trim()
  const c = String(charityName || '').trim()
  const what = c ? `Donation to ${c}` : 'Donation'
  return b ? `${b}: ${what}` : what
}

/**
 * Open a provider payment for an already-inserted `awaiting_payment` row and
 * persist the provider refs on it. The amount is the row's (validated by the
 * route against the event's min/max), never a client value. Throws
 * `payments_unavailable` when a Stripe host has not finished onboarding, and
 * throws if the ref cannot be persisted: a checkout nothing could ever settle
 * must not be handed out.
 */
export async function createDonationPayment({ db, donation, race, host, returnUrl }) {
  const provider = resolvePaymentProvider(host)
  if (provider === STRIPE_CONNECT && !hostCanTakePayments(host)) {
    const err = new Error('payments_unavailable')
    err.code = 'payments_unavailable'
    throw err
  }
  const connectedAccountId = host?.stripe_connected_account_id || null
  const { companyName } = await getLocationBranding(db, race.location_id)
  const settings = resolveCharitySettings(race)
  const currency = donation.currency || 'EUR'
  const created = await paymentsFor(provider).createPayment({
    amountCents: donation.amount_cents,
    currency,
    description: donationDescription(companyName, settings.name),
    returnUrl,
    metadata: { donation_id: donation.id, domain: 'un1t_donation', race_event_id: race.id, location_id: race.location_id },
    idempotencyKey: donation.id,
    connectedAccountId,
    applicationFeeCents: 0,
  })
  const { error } = await db.from('donations')
    .update({
      payment_provider: provider,
      payment_provider_ref: created.providerRef,
      payment_checkout_token: created.checkoutToken || null,
      payment_checkout_url: created.checkoutUrl || null,
      connected_account_id: connectedAccountId,
    })
    .eq('id', donation.id)
  if (error) throw new Error(`Failed to persist payment ref for donation ${donation.id}: ${error.message}`)
  return {
    donationId: donation.id,
    checkout: { provider, token: created.checkoutToken || null, url: created.checkoutUrl || null, connectedAccountId },
  }
}

/** Webhook lookup: the row that owns this provider order (null when none). */
export async function resolveDonationByRef(db, providerRef) {
  if (!providerRef) return null
  const { data, error } = await db.from('donations').select(DONATION_COLS).eq('payment_provider_ref', providerRef).maybeSingle()
  // A failed read is not "no such donation": throwing lets the provider redeliver.
  if (error) throw error
  return data || null
}

/**
 * Apply a provider state change. Returns { status, changed }: the donation's
 * status afterwards and whether THIS call moved it. `multiplier` is the
 * event's match multiplier, snapshotted onto the row when it is marked paid so
 * a later change to the event never rewrites history.
 */
export async function markDonationPaymentStatus({ db, donation, providerState, providerAmount, multiplier, now = () => new Date().toISOString() }) {
  if (IMMOVABLE.has(donation?.status)) return { status: donation.status, changed: false }
  const state = String(providerState || '').toLowerCase()

  let target = null
  let updates = null
  if (state === 'completed') {
    target = 'paid'
    updates = { status: 'paid', paid_at: now(), match_multiplier: Number(multiplier) >= 1 ? Number(multiplier) : 1 }
    if (Number.isFinite(providerAmount) && providerAmount > 0 && providerAmount !== donation.amount_cents) updates.amount_cents = providerAmount
  } else if (TERMINAL_FAILURE.has(donation?.status)) {
    return { status: donation.status, changed: false }
  } else if (state === 'failed' || state === 'cancelled' || state === 'expired') {
    target = state === 'failed' ? 'failed' : 'expired'
    updates = { status: target }
  } else {
    return { status: donation.status, changed: false }
  }

  const { data, error } = await db.from('donations')
    .update(updates)
    .eq('id', donation.id)
    .eq('status', donation.status)
    .select('id')
  if (error) throw error
  if (Array.isArray(data) && data.length === 0) {
    // Another observer moved the row first. Report what it settled on.
    const { data: current, error: readErr } = await db.from('donations').select('status').eq('id', donation.id).maybeSingle()
    if (readErr) throw readErr
    return { status: current?.status || donation.status, changed: false }
  }
  if (target === 'paid' && TERMINAL_FAILURE.has(donation.status)) {
    // The provider reported a failure and later a completion: money was taken,
    // so the donor gets their record, receipt and place in the totals.
    logError('donation-payments', 'completed after a terminal failure report; marked paid', { donationId: donation.id, from: donation.status })
  }
  return { status: target, changed: true }
}

/** paid -> refunded, recording who (a person for Revolut, null for a Stripe-reported refund). */
export async function markDonationRefunded({ db, donationId, byProfileId = null, now = () => new Date().toISOString() }) {
  const { data, error } = await db.from('donations')
    .update({ status: 'refunded', refunded_at: now(), refunded_by: byProfileId || null })
    .eq('id', donationId)
    .eq('status', 'paid')
    .select('id')
  if (error) throw error
  return { changed: Array.isArray(data) && data.length > 0 }
}

// The contact leg. Link (or create) the contact, tag it, record marketing
// consent, then stamp contact_id, then emit the timeline event. Everything
// before the stamp is idempotent, so a failure anywhere before it leaves the
// stamp unwritten and the next observation redoes the lot. The event is
// emitted only by the observer whose stamp write changed exactly one row, so
// two concurrent observers cannot both emit it; the cost is that a process
// dying between the stamp and the emit loses the event (it is never retried).
async function linkDonorContact({ db, donation, race, settings, ipAddress, out }) {
  let contactId = null
  let wonStamp = false
  try {
    contactId = await findOrCreateRaceContact({
      db, locationId: race.location_id, email: donation.donor_email, name: donation.donor_name || null,
    })
    if (!contactId) {
      out.contact = 'failed'
      logError('donation-payments', 'donor contact could not be linked', { donationId: donation.id })
      return null
    }

    const tag = await writeContactTag(db, {
      contactId, locationId: race.location_id, tag: 'donor', metadata: { donation_id: donation.id },
    })
    if (tag?.error) throw new Error(`donor tag not written: ${tag.error}`)

    if (donation.marketing_opt_in) {
      out.consent = 'failed'
      const consent = await applyFormMarketingConsent(db, {
        contactId, consent: true, source: 'donation', ipAddress: ipAddress || null, locationId: race.location_id,
      })
      if (consent?.ok === false) throw new Error(`marketing consent not recorded: ${consent.error || 'unknown'}`)
      out.consent = consent?.skipped ? 'skipped' : 'applied'
    }

    const { data: stamped, error } = await db.from('donations')
      .update({ contact_id: contactId })
      .eq('id', donation.id)
      .is('contact_id', null)
      .select('id')
    if (error) throw error
    wonStamp = Array.isArray(stamped) && stamped.length === 1
  } catch (e) {
    out.contact = 'failed'
    logError('donation-payments', 'donor contact step failed; the next observation of this paid donation retries it', { err: e, donationId: donation.id })
    return contactId
  }

  out.contact = 'linked'
  // Another observer stamped first and owns the event.
  if (!wonStamp) return contactId
  try {
    await emitEvent({
      db,
      eventType: EVENT_TYPES.DONATION_PAID,
      contactEmail: donation.donor_email,
      contactId,
      locationId: race.location_id,
      sourceType: 'donation',
      sourceId: donation.id,
      metadata: { amount_cents: donation.amount_cents, currency: donation.currency, charity: settings.name, event_name: race.name },
    })
  } catch (e) {
    logError('donation-payments', 'donation.paid timeline event failed', { err: e, donationId: donation.id })
  }
  return contactId
}

/**
 * Everything that follows a paid donation: the contact (+ donor tag, marketing
 * consent, timeline event) and the receipt. Safe to call on every observation
 * of a paid row; a step whose stamp is already set does nothing. Never throws.
 *
 * `donation` must be the paid row (match_multiplier is the snapshot); `race` is
 * the race_events row including charity, charity_enabled, location_id, name,
 * host_id and sending_location_id. Nothing is re-read.
 *
 * @returns {Promise<{ contact: 'linked'|'skipped'|'failed', consent: 'applied'|'skipped'|'failed',
 *   receipt: 'sent'|'suppressed'|'failed'|'skipped' }>}
 */
export async function runPaidDonationSideEffects({ db, donation, race, ipAddress = null }) {
  const out = { contact: 'skipped', consent: 'skipped', receipt: 'skipped' }
  // A stale row has no multiplier snapshot: refuse rather than send a receipt
  // that understates a matched gift.
  if (donation?.status !== 'paid') {
    logWarn('donation-payments', 'paid side effects refused: the row passed is not paid', { donationId: donation?.id, status: donation?.status })
    return out
  }
  let contactId = donation.contact_id || null
  const hasEmail = !!String(donation.donor_email || '').trim()
  let settings = null
  try {
    settings = resolveCharitySettings(race)
  } catch (e) {
    logError('donation-payments', 'charity settings unreadable for side effects', { err: e, donationId: donation.id })
    settings = { name: '' }
  }

  if (!donation.contact_id && hasEmail) {
    try {
      contactId = (await linkDonorContact({ db, donation, race, settings, ipAddress, out })) || null
    } catch (e) {
      out.contact = 'failed'
      logError('donation-payments', 'donor contact step crashed', { err: e, donationId: donation.id })
    }
  }

  if (!donation.receipt_email_sent_at && hasEmail) {
    try {
      const r = await sendDonationReceipt({
        db,
        donation: { ...donation, contact_id: contactId },
        race,
        contact: contactId ? { id: contactId, first_name: String(donation.donor_name || '').trim().split(/\s+/)[0] || '', name: donation.donor_name, email: donation.donor_email } : null,
      })
      out.receipt = r.status
    } catch (e) {
      out.receipt = 'failed'
      logError('donation-payments', 'donation receipt crashed', { err: e, donationId: donation.id })
      const { error } = await db.from('donations').update({ receipt_email_status: 'failed' }).eq('id', donation.id).is('receipt_email_sent_at', null)
      if (error) logError('donation-payments', 'receipt failure status not written', { err: error, donationId: donation.id })
    }
  }
  return out
}
