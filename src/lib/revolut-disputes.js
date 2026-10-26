// REVPAY.4 — Revolut dispute (chargeback) handling.
//
// The webhook (/api/webhooks/revolut/disputes) carries only
// { event, dispute_id }. The route re-reads the dispute from Revolut, then uses
// this module to (1) find which of our sales the disputed order belonged to,
// (2) upsert the revolut_disputes row, (3) note it on the orders ledger, and
// (4) tell staff. Every read here THROWS on a database error: the route turns a
// throw into "release the claim, answer 200 deferred", never a silent skip.

import { sendOpsAlert } from './ops-alerts'
import { sendTransactionalEmail } from './postmark'
import { sendPush } from './push'
import { excludeTombstones } from './staff-tombstone'
import { logWarn, logError } from './log'

// Where a Revolut order id can live. `select` always includes id + the
// location (race payments carry theirs on the parent event).
const SOURCES = [
  { type: 'car_deposit', table: 'cars', col: 'deposit_revolut_order_id', select: 'id, location_id', label: 'car deposit' },
  { type: 'race_registration', table: 'race_payments', col: 'payment_provider_ref', select: 'id, race:race_event_id ( location_id )', label: 'race registration' },
  { type: 'class_booking', table: 'class_booking_requests', col: 'payment_provider_ref', select: 'id, location_id', label: 'paid class booking' },
  { type: 'trial_purchase', table: 'trial_purchases', col: 'payment_provider_ref', select: 'id, location_id', label: 'paid trial' },
  { type: 'offer_purchase', table: 'offer_purchases', col: 'revolut_order_id', select: 'id, location_id', label: 'sale offer purchase' },
  { type: 'donation', table: 'donations', col: 'payment_provider_ref', select: 'id, location_id', label: 'donation' },
]

/**
 * Which of our rows owns this Revolut order. Returns
 * { source_type, source_id, location_id, label } or null when none does.
 * Throws on a read error (a failed read is not "not ours").
 */
export async function resolveDisputeSource(db, orderId) {
  if (!orderId) return null
  for (const s of SOURCES) {
    const { data, error } = await db.from(s.table).select(s.select).eq(s.col, orderId).limit(1)
    if (error) throw error
    const row = Array.isArray(data) ? data[0] : data
    if (row) {
      return {
        source_type: s.type,
        source_id: row.id,
        location_id: row.location_id ?? row.race?.location_id ?? null,
        label: s.label,
      }
    }
  }
  return null
}

// The dispute object as Revolut returned it, minus the payer's name.
function scrub(dispute) {
  const raw = JSON.parse(JSON.stringify(dispute ?? {}))
  if (raw?.payment?.payment_method) delete raw.payment.payment_method.debtor_name
  return raw
}

/** Map a Revolut Dispute object (+ our resolution) to a revolut_disputes row. */
export function disputeRow(dispute, source) {
  return {
    dispute_id: dispute.id,
    order_id: dispute.payment?.order_id ?? null,
    location_id: source?.location_id ?? null,
    source_type: source?.source_type ?? null,
    source_id: source?.source_id ?? null,
    state: dispute.state ?? null,
    reason: dispute.reason_description || dispute.reason_code || null,
    amount_cents: Number.isFinite(dispute.amount) ? dispute.amount : null,
    currency: dispute.currency ?? null,
    due_at: dispute.response_due_date ?? null,
    raw: scrub(dispute),
    updated_at: new Date().toISOString(),
  }
}

/** Upsert by Revolut's dispute id. Throws on error. */
export async function upsertDispute(db, dispute, source) {
  const row = disputeRow(dispute, source)
  const { error } = await db.from('revolut_disputes').upsert(row, { onConflict: 'dispute_id' })
  if (error) throw error
  return row
}

/**
 * Record the dispute on the orders ledger row for this Revolut order, if one
 * exists. orders.status has no 'disputed' value and this does not add one: the
 * dispute rides in metadata. Throws on error.
 */
export async function noteDisputeOnOrder(db, orderId, row) {
  if (!orderId) return false
  const { data, error } = await db.from('orders').select('id, metadata').eq('payment_provider_ref', orderId).limit(1)
  if (error) throw error
  const order = Array.isArray(data) ? data[0] : data
  if (!order) return false
  const metadata = {
    ...(order.metadata || {}),
    revolut_dispute: {
      dispute_id: row.dispute_id,
      state: row.state,
      reason: row.reason,
      amount_cents: row.amount_cents,
      currency: row.currency,
      due_at: row.due_at,
      updated_at: row.updated_at,
    },
  }
  const { error: upErr } = await db.from('orders').update({ metadata }).eq('id', order.id)
  if (upErr) throw upErr
  return true
}

function money(cents, currency) {
  if (!Number.isFinite(cents)) return 'an unknown amount'
  return `${(cents / 100).toFixed(2)} ${currency || 'EUR'}`
}

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * REVPAY.12 — the platform fallback for a dispute no studio can be told about
 * (an order that resolves to none of our rows, or a studio whose organisation
 * cannot be read). The Revolut merchant account is ONE platform account
 * (REVOLUT_API_KEY, not per organisation), so the platform's operators, the
 * masters, own a dispute nobody else can be matched to: the same audience and
 * channels as the fleet-health alert (email to every active, non-tombstoned
 * master, plus an UNCATEGORISED push, since an unregistered category fails
 * closed). Not every organisation's ops recipients: an unmatched dispute
 * belongs to no tenant, and its order id and amount are not theirs to see.
 * Best-effort; never throws. Returns whether anyone was reached.
 */
async function alertMastersOfDispute(db, { subject, htmlBody, pushBody, disputeId }) {
  let masters = []
  try {
    const { data, error } = await excludeTombstones(db.from('profiles')
      .select('id, email')
      .eq('role', 'master')
      .eq('active', true))
    if (error) throw error
    masters = Array.isArray(data) ? data : []
  } catch (e) {
    logError('revolut-disputes', 'masters unreadable: an unmatched dispute alerted NOBODY', { disputeId, err: e })
    return false
  }
  let delivered = false
  const ids = masters.map((m) => m.id).filter(Boolean)
  if (ids.length) {
    try {
      const res = await sendPush(ids, { title: subject, body: pushBody, data: { type: 'revolut_dispute' } })
      if ((res?.sent ?? 0) > 0) delivered = true
    } catch (e) {
      logWarn('revolut-disputes', 'dispute push to masters failed', { disputeId, err: e })
    }
  }
  for (const to of masters.map((m) => m.email).filter(Boolean)) {
    try {
      await sendTransactionalEmail({ to, subject, htmlBody, tag: 'ops-alert' })
      delivered = true
    } catch (e) {
      logWarn('revolut-disputes', 'dispute email to a master failed', { disputeId, err: e })
    }
  }
  if (!delivered) logError('revolut-disputes', 'unmatched dispute reached no master', { disputeId, masters: masters.length })
  return delivered
}

/**
 * Tell staff about a dispute: the studio organisation's ops-alert recipients
 * (push fallback), or, when the dispute cannot be tied to a studio's
 * organisation, the platform masters (alertMastersOfDispute).
 * Best-effort: never throws. Returns { sent: boolean, reason?, channel? }.
 */
export async function alertStaffOfDispute(db, event, row, source) {
  try {
    let loc = null
    let reason = null
    if (!row.location_id) {
      reason = 'no_location'
    } else {
      const { data, error } = await db
        .from('locations')
        .select('organization_id, name')
        .eq('id', row.location_id)
        .maybeSingle()
      if (error || !data?.organization_id) {
        logWarn('revolut-disputes', 'location unreadable for dispute alert', { disputeId: row.dispute_id, err: error })
        reason = 'no_org'
      } else {
        loc = data
      }
    }
    const lost = event === 'DISPUTE_LOST'
    const amount = money(row.amount_cents, row.currency)
    const what = source?.label || (reason === 'no_location' ? 'unmatched order' : 'sale')
    const due = row.due_at ? new Date(row.due_at).toUTCString() : 'not given'
    const subject = lost
      ? `CHARGEBACK LOST: ${amount} (${what})`
      : `CHARGEBACK - RESPONSE NEEDED: ${amount} (${what})`
    const unmatchedNote = reason === 'no_location'
      ? '<p>The disputed Revolut order matches no sale in the CRM, so no studio was told. Find it in the Revolut Business dashboard by its order id.</p>'
      : ''
    const htmlBody = `
      <p>${lost
        ? 'A card dispute was <strong>lost</strong>; the money is going back to the customer.'
        : 'A customer has disputed a card payment. <strong>Respond in the Revolut Business dashboard before the deadline</strong> or it is lost automatically.'}</p>
      ${unmatchedNote}
      <ul>
        <li>Amount: ${esc(amount)}</li>
        <li>Reason: ${esc(row.reason || 'not given')}</li>
        <li>Respond by: ${esc(due)}</li>
        <li>Sale: ${esc(what)}${source?.source_id ? ` (${esc(source.source_id)})` : ''}</li>
        <li>Studio: ${esc(loc?.name || row.location_id || 'unknown')}</li>
        <li>Revolut order: ${esc(row.order_id || 'unknown')}</li>
        <li>Dispute id: ${esc(row.dispute_id)}</li>
      </ul>`
    const pushBody = `${subject}. Respond by ${due}`
    if (!loc) {
      logError('revolut-disputes', 'dispute with no studio organisation to alert; alerting the platform masters', { disputeId: row.dispute_id, orderId: row.order_id, event, reason })
      const sent = await alertMastersOfDispute(db, { subject, htmlBody, pushBody, disputeId: row.dispute_id })
      return { sent, reason, channel: 'masters' }
    }
    await sendOpsAlert({
      organizationId: loc.organization_id,
      locationId: row.location_id,
      subject,
      htmlBody,
      pushBody,
    }, { db })
    return { sent: true }
  } catch (e) {
    logWarn('revolut-disputes', 'dispute alert failed', { disputeId: row.dispute_id, err: e })
    return { sent: false, reason: 'error' }
  }
}
