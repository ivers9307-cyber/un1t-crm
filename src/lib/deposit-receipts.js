// Buyer-facing receipt SMS when a car deposit is paid (mig 078).
//
// Fired from the Revolut webhook after the cars row flips to
// deposit_status=paid. Best-effort, fire-and-forget — a Twilio
// hiccup never blocks the webhook from returning 200, because
// returning anything else would re-trigger the upstream state
// machine (deposit_status update is the authoritative signal,
// the SMS is a customer-facing courtesy on top).
//
// Three gates before we send, in priority order:
//   1. locations.car_deposit_receipt_sms_enabled — per-location
//      opt-in. CCF Autos was backfilled to TRUE in mig 078; new
//      locations explicitly opt in via Settings → Locations →
//      Car deposit. If FALSE we return silently (no log spam).
//   2. cars.deposit_receipt_sent_at — idempotency. The Revolut
//      webhook is at-least-once, and even our own retry-on-failure
//      semantics could double-fire. The stamp lands ONLY after a
//      confirmed sendLocationSms success.
//   3. cars.buyer_phone — defensive. The deposit-link issue route
//      already requires this, but a future flow that creates a car
//      row some other way could skip it.
//
// On success we ALSO drop a system note into car_notes (matches
// the existing issue-deposit-link pattern — operators look there
// for the Twilio SID when a customer says "I never got the SMS").

import { sendLocationSms, TwilioError } from './twilio'
import { logWarn } from './log'

/**
 * @param {object} args
 * @param {object} args.db        Service-role Supabase client.
 * @param {object} args.car       Cars row including: id, location_id,
 *                                buyer_phone, buyer_name, make, model,
 *                                irish_reg, deposit_amount,
 *                                deposit_paid_amount, deposit_receipt_sent_at.
 * @param {object} args.location  Locations row including: id, name,
 *                                car_deposit_receipt_sms_enabled,
 *                                twilio_alpha_sender_id.
 * @param {string|null} [args.actorId]  Profile id of the operator if this
 *                                was called from a manual route. NULL when
 *                                called from the webhook (no user session).
 * @returns {Promise<
 *     { status: 'sent', sid: string, to: string, body: string, sent_at: string }
 *   | { status: 'skipped', reason: string }
 *   | { status: 'failed', reason: string }
 * >}
 */
export async function sendDepositReceiptSms({ db, car, location, actorId = null }) {
  // Gate 1: per-location toggle
  if (!location?.car_deposit_receipt_sms_enabled) {
    return { status: 'skipped', reason: 'location_toggle_off' }
  }

  // Gate 2: already sent — idempotency for at-least-once webhook delivery
  if (car.deposit_receipt_sent_at) {
    return { status: 'skipped', reason: 'already_sent' }
  }

  // Gate 3: no phone, nothing to send
  if (!car.buyer_phone) {
    return { status: 'skipped', reason: 'no_buyer_phone' }
  }

  const body = buildReceiptBody({ car, location })

  let smsResult
  try {
    smsResult = await sendLocationSms({ location, to: car.buyer_phone, body })
  } catch (e) {
    const msg = e instanceof TwilioError
      ? `Twilio ${e.code || e.status || ''}: ${e.message}`.trim()
      : (e?.message || 'SMS send failed')
    logWarn('deposit-receipt', 'SMS send failed', { carId: car.id, reason: msg })
    return { status: 'failed', reason: msg }
  }

  const sentAt = new Date().toISOString()

  // Stamp the idempotency column. If THIS fails (rare — would need a DB
  // outage between the SMS send and the update), the worst case is a
  // duplicate SMS on the next webhook retry. The alternative (returning
  // failed) would lose the "we already sent it" signal entirely, which
  // is worse than a possible duplicate.
  try {
    await db.from('cars').update({ deposit_receipt_sent_at: sentAt }).eq('id', car.id)
  } catch (e) {
    logWarn('deposit-receipt', 'stamp failed after SMS sent', {
      carId: car.id, twilioSid: smsResult?.sid, err: e,
    })
  }

  // System note on the car timeline. Matches the issue-deposit-link
  // pattern: includes the recipient phone + the Twilio SID so operators
  // can cross-reference in Twilio Console → Monitor → Logs → Messaging
  // when a customer reports non-receipt.
  try {
    await db.from('car_notes').insert({
      car_id: car.id,
      location_id: car.location_id,
      kind: 'system',
      created_by: actorId,
      content:
        `Deposit receipt SMS sent to ${car.buyer_phone} ` +
        `(Twilio sid ${smsResult?.sid || 'unknown'}).\n${body}`,
    })
  } catch (e) {
    logWarn('deposit-receipt', 'failed to write car_notes entry', { carId: car.id, err: e })
  }

  return {
    status: 'sent',
    sid: smsResult?.sid,
    to: smsResult?.to,
    body,
    sent_at: sentAt,
  }
}

/**
 * Build the SMS body. Pure — exported so tests can assert on it
 * without standing up the full send flow. Single segment where
 * possible (~140 chars depending on car-name length); long car
 * names will spill into a second segment but Twilio bills correctly
 * regardless.
 *
 * @param {object} args
 * @param {object} args.car       Cars row with buyer_name, make, model, irish_reg, deposit_amount, deposit_paid_amount.
 * @param {object} args.location  Locations row with name.
 */
export function buildReceiptBody({ car, location }) {
  const firstName = (car.buyer_name || '').trim().split(/\s+/)[0] || 'there'
  const carLabel =
    [car.make, car.model, car.irish_reg].map((p) => (p || '').trim()).filter(Boolean).join(' ') ||
    'your car'

  // Prefer the actual captured amount (set by the webhook from Revolut's
  // order.amount). Falls back to the configured deposit_amount if for
  // some reason the captured amount didn't make it through.
  const rawAmount = Number(
    car.deposit_paid_amount != null ? car.deposit_paid_amount : car.deposit_amount
  )
  const amountLabel = Number.isFinite(rawAmount) && rawAmount > 0
    ? `€${rawAmount.toFixed(2)} `
    : ''

  const brand = (location?.name || '').trim() || 'CCF Autos'

  return (
    `Hi ${firstName}, we've received your ${amountLabel}deposit for ${carLabel}. ` +
    `Thanks — we'll be in touch shortly to arrange next steps. ${brand}.`
  )
}

/**
 * Buyer-facing deposit-link SMS. Uses the actual car label (make/model/reg)
 * the caller already computed — no hard-coded make. Kept short for a single
 * Twilio segment where the label allows.
 * @param {object} args { firstName, amount, carLabel, link }
 */
export function buildDepositSmsBody({ firstName, amount, carLabel, link }) {
  return `Hi ${firstName}, your €${Number(amount).toFixed(2)} deposit for ${carLabel}: ${link} (link valid 24h)`
}
