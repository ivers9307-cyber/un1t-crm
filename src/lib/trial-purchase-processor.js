// PAIDTRIAL.1 — fulfil ONE paid trial purchase: put the Glofox plan on the
// buyer's account. Runs after the money is in (payment_status 'paid'), from
// the QStash worker or the process-trial-purchases cron, under the claim CAS
// in trial-purchase-queue.js.
//
// Order:
//   1. the row must be paid; anything else is a review item, never a grant;
//   2. the contact (the public route created or matched it);
//   3. Glofox credentials: an unreadable settings row THROWS (the queue
//      retries); a studio with none is a review item;
//   4. the account: a contact already linked to a Glofox member is used as is;
//      otherwise findOrCreateGlofoxMember searches by email, then phone, then
//      registers (attachTrial: false — a PAID trial never buys the free trial
//      product). A needs_review from it (several accounts match, a phone
//      match on a stranger) goes to staff with the reason; a failed search
//      throws so the queue retries;
//   5. the grant, write-ahead (TRIALGRANT.1): `grant = { stage: 'purchasing' }`
//      is written on the row before purchaseGlofoxMembership, the outcome
//      after it. A marker with no outcome on a later run means Glofox may
//      have bought it: never bought again, staff check the €0 invoice
//      (grant_unverified). A recorded ok grant is never bought again either
//      (a re-run after a side-effect failure just finishes the side effects);
//   6. side effects, best-effort and independent: the confirmation email,
//      the Meta Purchase (the studio's own dataset, event id shared with the
//      browser's Purchase so Meta counts one).
// A failure after the money is taken is never silent: status needs_review +
// last_error + an ops alert to the organisation's recipients.
import { glofoxCredentialsForLocation, missingGlofoxCredentialsForLocation, purchaseGlofoxMembership } from '@/lib/glofox'
import { findOrCreateGlofoxMember } from '@/lib/glofox-push'
import { sendWebsiteConversion } from '@/lib/meta-capi'
import { sendOpsAlert } from '@/lib/ops-alerts'
import { sendTrialPurchaseEmail } from '@/lib/trial-purchase-emails'
import { logError, logWarn } from '@/lib/log'
import { escapeHtml } from '@/lib/html-escape'
import { placeContactNow } from '@/lib/pipeline-place-now'
import { queueFundedClassBooking, fundedBookingFromRow, FUNDED_BY } from '@/lib/class-first-booking'

/** PAIDTRIAL.4 — the body of every paid-trial plan purchase (see the call). */
export const TRIAL_PURCHASE_BODY = Object.freeze({ payment_method: 'complimentary' })

export const REVIEW_REASONS = Object.freeze({
  unpaid_row: 'The row reached the processor without a settled payment.',
  contact_missing: 'The buyer\'s contact could not be read.',
  glofox_not_configured: 'Glofox is not connected at this studio.',
  account_needs_review: 'The Glofox account could not be chosen safely.',
  account_create_failed: 'The Glofox account could not be found or created.',
  grant_refused: 'Glofox refused the plan purchase.',
  grant_unverified: 'Glofox gave no clear answer to the plan purchase; it may have gone through. Check the member\'s invoices before granting by hand.',
  grant_unrecorded: 'The grant marker could not be written, so nothing was bought.',
  trial_used: 'The buyer already had a trial here and asked for help.',
  active_member: 'The buyer already holds an active membership and asked for help.',
  un1t_account_refused: 'un1t.online would not give this buyer an account.',
  un1t_checkout_refused: 'un1t.online refused the checkout.',
  un1t_outcome_unknown: 'un1t.online gave no clear answer.',
})

async function stamp(db, id, fields, { expectStatus = 'processing' } = {}) {
  let q = db.from('trial_purchases').update(fields).eq('id', id)
  if (expectStatus) q = q.eq('status', expectStatus)
  const { data, error } = await q.select('id')
  if (error) throw error
  return (data || []).length > 0
}

/**
 * Email/push the studio's ops contacts about a trial purchase row. Every value
 * interpolated into the HTML is escaped: the buyer details come from the
 * anonymous /trial page and `extra` carries Glofox's own words. A row whose
 * status is `help_requested` gets the help-request subject.
 */
export async function alertTrialPurchaseStaff(db, row, reason, extra = '') {
  try {
    const { data: loc } = await db.from('locations').select('organization_id, name').eq('id', row.location_id).maybeSingle()
    if (!loc?.organization_id) return
    const helpRequest = row.status === 'help_requested'
    const reasonHtml = `${escapeHtml(REVIEW_REASONS[reason] || reason)}${extra ? ` (${escapeHtml(extra)})` : ''}`
    const buyerHtml = `${escapeHtml(row.customer_name || '')} &lt;${escapeHtml(row.customer_email)}&gt; ${escapeHtml(row.customer_phone || '')}`
    // A un1t.online (Hatch) row has no Glofox ids: name its un1t.online product instead.
    const un1tRow = row.membership_id == null && row.plan_code == null && row.un1t_product_id
    const productHtml = un1tRow
      ? `(${escapeHtml(row.product_name)}, un1t.online product ${escapeHtml(row.un1t_product_id)})`
      : `${escapeHtml(row.product_name)} (${escapeHtml(row.membership_id)} / ${escapeHtml(row.plan_code)})`
    // A un1t_* reason is un1t.online refusing the buyer at checkout, not the buyer asking.
    const helpOpening = typeof reason === 'string' && reason.startsWith('un1t_')
      ? 'A customer tried to buy the trial on the /trial page but un1t.online could not give them an account or a checkout; they were not charged.'
      : 'A customer asked for help on the /trial page and was not charged.'
    await sendOpsAlert({
      organizationId: loc.organization_id,
      locationId: row.location_id,
      subject: helpRequest
        ? `Trial help request: ${row.customer_name || row.customer_email} (${loc.name || 'studio'})`
        : `Paid trial needs a hand: ${row.customer_name || row.customer_email} (${loc.name || 'studio'})`,
      htmlBody: helpRequest
        ? `<p>${helpOpening}</p>` +
          `<p><strong>Reason:</strong> ${reasonHtml}</p>` +
          `<p><strong>Buyer:</strong> ${buyerHtml}<br/>` +
          `<strong>Product:</strong> ${productHtml}<br/>` +
          `<strong>Purchase id:</strong> ${escapeHtml(row.id)}</p>` +
          `<p>Open the Paid trials tab on the CRM's Approvals page, contact the customer, then mark the card handled.</p>`
        : `<p>A paid trial purchase was taken but the plan was not put on the account automatically.</p>` +
          `<p><strong>Reason:</strong> ${reasonHtml}</p>` +
          `<p><strong>Buyer:</strong> ${buyerHtml}<br/>` +
          `<strong>Product:</strong> ${productHtml}<br/>` +
          `<strong>Paid:</strong> ${(row.amount_cents / 100).toFixed(2)} ${escapeHtml(row.currency)}<br/>` +
          `<strong>Purchase id:</strong> ${escapeHtml(row.id)}</p>` +
          `<p>Open the Paid trials tab on the CRM's Approvals page to retry the grant or mark it done once you have put the plan on the account in Glofox.</p>`,
      pushBody: helpRequest
        ? `${row.customer_name || row.customer_email} asked for help with a trial (${reason}).`
        : `Paid trial for ${row.customer_name || row.customer_email} needs a manual grant (${reason}).`,
    }, { db })
  } catch (e) {
    logWarn('trial-purchase', 'ops alert failed', { purchaseId: row.id, err: e })
  }
}

// PAIDTRIAL.3 — a system note on the contact: another Glofox account already
// holds this mobile. Best-effort; the grant never waits on it.
async function notePhoneMatch(db, row, contact, phoneMatch) {
  const ids = (phoneMatch.glofox_member_ids || []).join(', ')
  const content = `Paid trial (${row.product_name}): a new Glofox account was created on ${row.customer_email} because no account had that email, but ${phoneMatch.matches === 1 ? 'an existing Glofox account already holds' : `${phoneMatch.matches} existing Glofox accounts already hold`} this mobile number${ids ? ` (Glofox id ${ids})` : ''}. If it is the same person, merge the accounts in Glofox.`
  try {
    const { error } = await db.from('notes').insert({ contact_id: contact.id, content })
    if (error) logWarn('trial-purchase', 'phone-match note failed', { purchaseId: row.id, err: error })
  } catch (e) {
    logWarn('trial-purchase', 'phone-match note threw', { purchaseId: row.id, err: e })
  }
}

async function toReview(db, row, reason, { extra = '', grant } = {}) {
  const fields = { status: 'needs_review', last_error: `${reason}${extra ? `: ${extra}` : ''}` }
  if (grant) fields.grant = grant
  try { await stamp(db, row.id, fields) } catch (e) { logWarn('trial-purchase', 'review stamp failed', { purchaseId: row.id, err: e }) }
  logError('trial-purchase', 'plan not granted; staff alerted', { purchaseId: row.id, reason })
  await alertTrialPurchaseStaff(db, row, reason, extra)
  return { outcome: 'needs_review', reason }
}

/**
 * @returns {Promise<{ outcome: 'granted'|'needs_review'|'skipped', reason?: string }>}
 * Throws only for a read the queue should retry.
 */
export async function processTrialPurchase(db, row, { now = () => new Date().toISOString() } = {}) {
  if (row.payment_status !== 'paid') return toReview(db, row, 'unpaid_row')

  // 2. the buyer
  const { data: contact, error: cErr } = row.contact_id
    ? await db.from('contacts').select('id, email, first_name, last_name, phone, dob, glofox_member_id, location_id').eq('id', row.contact_id).maybeSingle()
    : { data: null, error: null }
  if (cErr) throw new Error(`contact read failed: ${cErr.message}`)
  if (!contact) return toReview(db, row, 'contact_missing')

  // 3. credentials
  const creds = await glofoxCredentialsForLocation(db, row.location_id)
  if (creds?.readError) throw new Error('glofox settings unreadable')
  // The helper returns the LIST of missing fields: an empty list is still
  // truthy, which is how the first live purchase (21 Oct 2026) went to
  // review as glofox_not_configured at a configured studio.
  if (missingGlofoxCredentialsForLocation(creds).length) return toReview(db, row, 'glofox_not_configured')

  // 4. the account
  let memberId = contact.glofox_member_id || row.glofox_member_id || null
  if (!memberId) {
    // PAIDTRIAL.3 — phoneMatchPolicy 'create': the buyer has PAID, so a
    // Glofox account that already holds their mobile under another email
    // does not hold up the grant (the free-trial funnel's rule guards a
    // second free trial; there is none here). The account is created on the
    // email they paid with and the match is noted on the contact for a
    // later merge. Richard's call, 21 Oct 2026.
    const res = await findOrCreateGlofoxMember({ db, locationId: row.location_id, contact, source: 'paid_trial', createIfMissing: true, attachTrial: false, phoneMatchPolicy: 'create' })
    if (res?.status === 'needs_review') return toReview(db, row, 'account_needs_review', { extra: res.error || '' })
    if (res?.status === 'failed' || !res?.glofox_member_id) {
      // A failed Glofox search is a read: retry it. Anything else is for staff.
      if (/search failed/i.test(String(res?.error || ''))) throw new Error(`glofox search failed: ${res.error}`)
      return toReview(db, row, 'account_create_failed', { extra: res?.error || '' })
    }
    memberId = String(res.glofox_member_id)
    if (res.phone_match) await notePhoneMatch(db, row, contact, res.phone_match)
  }

  // 5. the grant, write-ahead
  const prior = row.grant && typeof row.grant === 'object' ? row.grant : null
  let grant = prior
  if (!(prior?.ok === true)) {
    if (prior?.stage === 'purchasing' && prior?.ok !== false) {
      return toReview(db, row, 'grant_unverified', { grant: { ...prior, unverified_at: now() } })
    }
    const marker = { stage: 'purchasing', at: now(), glofox_member_id: memberId, membership_id: row.membership_id, plan_code: row.plan_code }
    let marked = false
    try { marked = await stamp(db, row.id, { grant: marker, glofox_member_id: memberId }) } catch { marked = false }
    if (!marked) return toReview(db, row, 'grant_unrecorded')

    // PAIDTRIAL.4 — the CRM has already taken the money, so the Glofox
    // purchase is recorded as complimentary: Glofox then raises a receipt
    // instead of trying to charge a card it does not have. The field and the
    // value are from Glofox's Purchase Membership spec (payment_method,
    // lowercase, one of the methods the membership's configuration accepts;
    // the payment-methods object lists `complimentary`), read 21 Oct 2026.
    // The plan must accept complimentary in Glofox, or the purchase is
    // refused the same way a card-less one is (a review card, never a charge).
    const res = await purchaseGlofoxMembership(creds, memberId, row.membership_id, row.plan_code, { body: TRIAL_PURCHASE_BODY })
    if (res.ok) {
      grant = { ok: true, at: now(), glofox_member_id: memberId, invoice_id: res.invoice_id || null, purchase_status: res.purchase_status || null }
    } else if (res.outcome_unknown) {
      return toReview(db, row, 'grant_unverified', {
        extra: res.error || '',
        grant: { ...marker, ok: null, outcome_unknown: true, http_status: res.http_status ?? null, error: res.error || null },
      })
    } else {
      return toReview(db, row, 'grant_refused', {
        extra: res.error || res.message_code || '',
        grant: { ...marker, ok: false, glofox_message_code: res.message_code || null, http_status: res.http_status ?? null, error: res.error || null },
      })
    }
    const ok = await stamp(db, row.id, { grant, granted_at: grant.at, status: 'granted', glofox_member_id: memberId, last_error: null })
    if (!ok) logWarn('trial-purchase', 'granted but the row could not be stamped; the sweeper will see processing', { purchaseId: row.id })
  } else {
    // A recorded grant on a re-run: finish the side effects only.
    try { await stamp(db, row.id, { status: 'granted', granted_at: prior.at || now(), glofox_member_id: memberId, last_error: null }) } catch (e) { logWarn('trial-purchase', 're-run stamp failed', { purchaseId: row.id, err: e }) }
  }

  // CLASSFIRST.1 — the class they picked before paying: queued now, booked
  // against the plan's credits by the class-booking worker. Best-effort: the
  // grant already landed, and the helper logs its own failures.
  try {
    const funded = fundedBookingFromRow({ ...row, contact_id: contact.id }, { fundedBy: FUNDED_BY.trialPurchase })
    if (funded) await queueFundedClassBooking(db, funded)
  } catch (e) { logWarn('trial-purchase', 'funded class booking not queued', { purchaseId: row.id, err: e }) }

  // PIPE3.7 — the buyer's card moves to the €39 Trial board now, not at
  // tonight's run. Best-effort: the grant already landed.
  try {
    await placeContactNow(db, { locationId: row.location_id, contactId: contact.id })
  } catch (e) { logWarn('trial-purchase', 'board placement failed', { purchaseId: row.id, err: e }) }

  // 6. side effects, independent and best-effort
  try { await sendTrialPurchaseEmail(db, { purchase: { ...row, glofox_member_id: memberId }, kind: 'granted' }) } catch (e) { logWarn('trial-purchase', 'confirmation email failed', { purchaseId: row.id, err: e }) }
  try {
    await sendWebsiteConversion(db, {
      locationId: row.location_id,
      eventName: 'Purchase',
      email: row.customer_email, phone: row.customer_phone,
      firstName: row.first_name, lastName: row.last_name,
      externalId: row.contact_id,
      eventSourceUrl: row.attribution?.event_source_url || undefined,
      eventId: `trialpurchase-${row.id}`,
      contentName: row.product_name,
      // PURCHASEVALUE.1 — what the browser's Purchase already says: the
      // amount taken, its currency, and our purchase id as the order.
      value: (row.amount_cents || 0) / 100, currency: row.currency || 'EUR',
      orderId: row.id, contentType: 'product',
      fbc: row.attribution?.fbc, fbp: row.attribution?.fbp,
    })
  } catch (e) { logWarn('trial-purchase', 'capi purchase failed', { purchaseId: row.id, err: e }) }

  return { outcome: 'granted' }
}
