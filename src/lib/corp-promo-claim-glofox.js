// NEWSTART.1c — fulfil one /corp promo claim at a GLOFOX studio (the
// /newstart promo at Stillorgan): buy the promo's €0 plan on the person's
// Glofox account. The un1t.online sibling is corp-promo-claim.js; this one
// mirrors processTrialPurchase (trial-purchase-processor.js) for the account
// and the write-ahead purchase.
//
// The corp_promo_claims row is already inserted (status processing). Order:
//   1. the plan: no Glofox ids for the promo yet → row failed (plan_missing);
//   2. credentials: an unreadable settings row → row failed (the page says try
//      again); a studio with none → help;
//   3. the account: a contact already linked is used as is; otherwise
//      findOrCreateGlofoxMember (email, then phone, then register;
//      attachTrial false, phoneMatchPolicy 'review': a mobile-only match on a
//      stranger goes to the team). needs_review / failure → help;
//   4. the live plan, for an account that already existed: a live plan or any
//      credit balance → help, no purchase. A failed read is UNKNOWN, never
//      "nothing live" → help, no purchase. A new account skips this;
//   5. the write-ahead marker: `grant = { stage: 'purchasing' }` on the row,
//      guarded on status processing and no grant yet, judged on the rows it
//      touched. No marker, no purchase;
//   6. the purchase, ONCE (purchaseGlofoxMembership never re-sends after a
//      5xx; nothing here re-sends either): ok → granted; no clear answer →
//      help (check the €0 invoice); refused → help with Glofox's code;
//   7. after the grant, each best-effort: the funded class booking, the board
//      placement, the confirmation email.
// Help = row help_requested with the reason + the ops alert to the
// organisation (the approvals card reads the row). A failed/help stamp only
// moves a row still processing, so it never overwrites another run's grant;
// a marker refused because another run's marker or outcome is already on the
// row files nothing and buys nothing (the stalled sweep owns that row). Logs carry ids and codes
// only, never the email, phone, name or the new account's password.
import { glofoxCredentialsForLocation, missingGlofoxCredentialsForLocation, fetchMemberResult, fetchUserCreditsResult, purchaseGlofoxMembership } from '@/lib/glofox'
import { findOrCreateGlofoxMember } from '@/lib/glofox-push'
import { mapMembershipStatus, computeCreditsRemaining } from '@/lib/glofox-sync'
import { TRIAL_PURCHASE_BODY } from '@/lib/trial-purchase-processor'
import { glofoxPlanForPromo } from '@/lib/corp-promo-glofox-plans'
import { sendCorpPromoEmail } from '@/lib/corp-promo-emails'
import { sendOpsAlert } from '@/lib/ops-alerts'
import { placeContactNow } from '@/lib/pipeline-place-now'
import { queueFundedClassBooking, fundedBookingFromRow, FUNDED_BY } from '@/lib/class-first-booking'
import { escapeHtml } from '@/lib/html-escape'
import { logError, logWarn } from '@/lib/log'

const LOG = 'corp-promo-glofox'

/** A Glofox status that means the person already holds something live there. */
const LIVE_PLAN_STATUSES = new Set(['member', 'trial', 'credit_member', 'classpass_payg'])

/** What staff should do, per reason prefix (the alert's second line). */
const HELP_ADVICE = Object.freeze({
  glofox_not_configured: 'Glofox is not connected at this studio, so nothing was tried.',
  account_needs_review: 'The Glofox account could not be chosen safely (several accounts match, or another account holds this mobile). Pick or merge the right account in Glofox, then add the plan by hand if they qualify.',
  account_create_failed: 'The Glofox account could not be found or created. Create it in Glofox, then add the plan by hand if they qualify.',
  live_plan: 'Their Glofox account already holds a live plan or credits, so nothing was bought. Decide whether they qualify.',
  glofox_read_failed: 'Their Glofox account could not be read, so nothing was bought. Check it in Glofox, then add the plan by hand if they qualify.',
  grant_unrecorded: 'The purchase marker could not be written, so nothing was bought. Add the plan by hand if they qualify.',
  grant_refused: 'Glofox refused the plan purchase, so nothing was bought.',
  grant_unverified: "The plan purchase may have gone through (Glofox gave no clear answer, or another attempt on this claim could not be checked). Check the member's invoices in Glofox for a €0 New Start invoice BEFORE adding anything by hand.",
})
const adviceFor = (reason) => HELP_ADVICE[String(reason).split(':')[0]] || ''

/**
 * @param {object} db service-role client
 * @param {{ claim: object, location: { id: string, name: string|null, organization_id: string|null },
 *   contact: { id: string, email: string, first_name?: string|null, last_name?: string|null,
 *   phone?: string|null, dob?: string|null, glofox_member_id?: string|null },
 *   promo: import('./corp-promos').CorpPromo, copy: object, zone: string }} args
 * @param {object} [deps] test seams
 * @returns {Promise<{ kind: 'granted', credits: number, expiresAt: null } | { kind: 'help_filed' } | { kind: 'unavailable' }>}
 */
export async function fulfilGlofoxCorpPromoClaim(db, { claim, location, contact, promo, copy, zone }, deps = {}) {
  const d = {
    glofoxPlanForPromo, glofoxCredentialsForLocation, missingGlofoxCredentialsForLocation, findOrCreateGlofoxMember,
    fetchMemberResult, fetchUserCreditsResult, purchaseGlofoxMembership, mapMembershipStatus, computeCreditsRemaining,
    queueFundedClassBooking, placeContactNow, sendCorpPromoEmail, sendOpsAlert,
    now: () => new Date(), ...deps,
  }
  const locationId = claim.location_id
  const ids = { claimId: claim.id, locationId }
  const nowIso = () => d.now().toISOString()

  const stamp = async (patch) => {
    const { error } = await db.from('corp_promo_claims').update(patch).eq('id', claim.id).eq('location_id', locationId)
    if (error) logError(LOG, 'claim not stamped', { ...ids, status: patch.status ?? null, code: error.code ?? null })
    return error || null
  }
  // A failure or help stamp only ever moves a row that is still processing:
  // it must never overwrite another run's granted row (or the stalled sweep's
  // help card). Judged on the rows it touched: 0 → null, an error → undefined.
  const stampOpen = async (patch) => {
    try {
      const { data, error } = await db.from('corp_promo_claims').update(patch)
        .eq('id', claim.id).eq('location_id', locationId).eq('status', 'processing')
        .select('id')
      if (error) {
        logError(LOG, 'claim not stamped', { ...ids, status: patch.status ?? null, code: error.code ?? null })
        return undefined
      }
      return (data || []).length
    } catch (e) {
      logError(LOG, 'claim stamp threw', { ...ids, status: patch.status ?? null, errClass: e?.name })
      return undefined
    }
  }
  const failed = async (reason) => {
    await stampOpen({ status: 'failed', reason })
    return { kind: 'unavailable' }
  }
  let memberId = null
  // Set just before the purchase call: from then on this run holds facts no
  // one else has, so staff are alerted even if the row moved on meanwhile.
  let purchaseAttempted = false
  const help = async (reason, { grant } = {}) => {
    const patch = { status: 'help_requested', reason }
    if (memberId) patch.glofox_member_id = memberId
    if (grant) patch.grant = grant
    const touched = await stampOpen(patch)
    if (touched === 0 && !purchaseAttempted) {
      // The row is no longer processing: another run granted it, or the
      // stalled sweep filed it. Not ours to file again; the page says try again.
      logWarn(LOG, 'claim no longer processing; help not filed', { ...ids, reason: String(reason).split(':')[0] })
      return { kind: 'unavailable' }
    }
    logWarn(LOG, 'promo not granted; staff alerted', { ...ids, reason: String(reason).split(':')[0], glofoxMemberId: memberId })
    try {
      if (location.organization_id) {
        const person = `${claim.first_name || ''} ${claim.last_name || ''}`.trim()
        await d.sendOpsAlert({
          organizationId: location.organization_id,
          locationId,
          subject: `Promo needs a hand: ${person} (${location.name || 'studio'})`.replace(/\s+/g, ' '),
          htmlBody:
            `<p>Someone claimed the ${escapeHtml(promo.name || promo.key)} promo, but their free classes could not be put on their Glofox account automatically. Nothing was charged.</p>` +
            `<p><strong>Reason:</strong> ${escapeHtml(reason)}<br/>${escapeHtml(adviceFor(reason))}</p>` +
            `<p><strong>Person:</strong> ${escapeHtml(person)} &lt;${escapeHtml(claim.customer_email || '')}&gt; ${escapeHtml(claim.customer_phone || '')}<br/>` +
            (memberId ? `<strong>Glofox member id:</strong> ${escapeHtml(memberId)}<br/>` : '') +
            `<strong>Claim id:</strong> ${escapeHtml(claim.id)}</p>` +
            `<p>If they qualify, add the ${escapeHtml(promo.name || promo.key)} plan (${promo.credits} classes) in Glofox by hand, then mark the card handled on the Approvals page.</p>`,
        })
      }
    } catch (e) {
      logWarn(LOG, 'staff alert failed', { ...ids, errClass: e?.name })
    }
    return { kind: 'help_filed' }
  }

  // ── 1. The plan ──
  const plan = d.glofoxPlanForPromo(promo.key)
  if (!plan) return failed('plan_missing')

  // ── 2. Credentials ──
  const creds = await d.glofoxCredentialsForLocation(db, locationId)
  if (creds?.readError) return failed('glofox_settings_unreadable')
  // The helper returns the LIST of missing fields: an empty list is still truthy.
  if (d.missingGlofoxCredentialsForLocation(creds).length) return help('glofox_not_configured')

  // ── 3. The account ──
  memberId = contact.glofox_member_id || claim.glofox_member_id || null
  let created = false
  if (!memberId) {
    let res
    try {
      res = await d.findOrCreateGlofoxMember({
        db, locationId, contact, source: 'corp_promo', createIfMissing: true, attachTrial: false, phoneMatchPolicy: 'review',
      })
    } catch (e) {
      logError(LOG, 'account step threw', { ...ids, errClass: e?.name })
      return help(`account_create_failed: ${e?.message || 'error'}`)
    }
    if (res?.status === 'needs_review') {
      if (res.glofox_member_id) memberId = String(res.glofox_member_id)
      return help(`account_needs_review: ${res.error || 'no reason given'}`)
    }
    if (res?.status === 'failed' || !res?.glofox_member_id) {
      return help(`account_create_failed: ${res?.error || res?.code || 'no member id'}`)
    }
    memberId = String(res.glofox_member_id)
    created = res.status === 'created'
  }

  // ── 4. The live plan (an account that already existed) ──
  if (!created) {
    let member
    try { member = await d.fetchMemberResult(creds, memberId) } catch { member = null }
    if (!member?.ok) return help('glofox_read_failed')
    const status = d.mapMembershipStatus(member.member)
    if (LIVE_PLAN_STATUSES.has(status)) return help(`live_plan: ${status}`)
    let credits
    try { credits = await d.fetchUserCreditsResult(creds, memberId) } catch { credits = null }
    if (!credits?.ok) return help('glofox_read_failed')
    if ((d.computeCreditsRemaining(credits.credits) ?? 0) > 0) return help('live_plan: credits')
  }

  // ── 5. The write-ahead marker: no marker, no purchase ──
  const marker = { stage: 'purchasing', at: nowIso(), glofox_member_id: memberId, membership_id: plan.membershipId, plan_code: plan.planCode }
  let marked = false
  try {
    const { data, error } = await db.from('corp_promo_claims')
      .update({ grant: marker, glofox_member_id: memberId })
      .eq('id', claim.id).eq('location_id', locationId)
      .eq('status', 'processing').is('grant', null)
      .select('id')
    if (error) logError(LOG, 'grant marker not written', { ...ids, code: error.code ?? null })
    marked = !error && (data || []).length > 0
  } catch (e) {
    logError(LOG, 'grant marker threw', { ...ids, errClass: e?.name })
  }
  if (!marked) {
    // 0 rows (or an error) may mean ANOTHER run got here first: its marker or
    // outcome is on the row, and it may have bought the plan. Re-read before
    // saying "nothing was bought": staff acting on that would add a second plan.
    let current = null
    let readFailed = false
    try {
      const { data, error } = await db.from('corp_promo_claims').select('status, grant')
        .eq('id', claim.id).eq('location_id', locationId).maybeSingle()
      if (error) readFailed = true
      else current = data
    } catch {
      readFailed = true
    }
    if (readFailed) {
      logError(LOG, 'claim unreadable after the marker was refused', { ...ids })
      return help('grant_unverified')
    }
    if (current && (current.status === 'granted' || (current.grant && typeof current.grant === 'object'))) {
      logWarn(LOG, 'another run holds the grant; nothing bought here', { ...ids, status: current.status ?? null })
      return { kind: 'unavailable' }
    }
    return help('grant_unrecorded')
  }

  // ── 6. The purchase, once ──
  let res
  purchaseAttempted = true
  try {
    res = await d.purchaseGlofoxMembership(creds, memberId, plan.membershipId, plan.planCode, { body: TRIAL_PURCHASE_BODY })
  } catch (e) {
    // purchaseGlofoxMembership never throws; if it ever does, the call may have
    // reached Glofox, so it is a doubt, never a refusal and never a re-send.
    res = { ok: false, outcome_unknown: true, http_status: null, message_code: null, error: e?.message || 'threw' }
  }
  if (!res?.ok) {
    if (res?.outcome_unknown) {
      return help('grant_unverified', {
        grant: { ...marker, ok: null, outcome_unknown: true, http_status: res.http_status ?? null, error: res.error || null },
      })
    }
    return help(`grant_refused: ${res?.message_code || res?.error || 'no code'}`, {
      grant: { ...marker, ok: false, glofox_message_code: res?.message_code || null, http_status: res?.http_status ?? null, error: res?.error || null },
    })
  }
  const grant = {
    ok: true, at: nowIso(), glofox_member_id: memberId, membership_id: plan.membershipId, plan_code: plan.planCode,
    invoice_id: res.invoice_id || null, purchase_status: res.purchase_status || null,
  }
  const grantedRow = { ...claim, contact_id: contact.id, status: 'granted', glofox_member_id: memberId, grant, credits: promo.credits, expires_at: null }
  // The plan is bought whatever the row says: a failed stamp is logged
  // (stamp) and the person is still told.
  await stamp({ status: 'granted', reason: null, glofox_member_id: memberId, grant, credits: promo.credits, expires_at: null })

  // ── 7. After the grant, each best-effort and independent ──
  try {
    const funded = fundedBookingFromRow(grantedRow, { fundedBy: FUNDED_BY.corpPromo })
    if (funded) await d.queueFundedClassBooking(db, funded)
  } catch (e) {
    logWarn(LOG, 'funded class booking not queued', { ...ids, errClass: e?.name })
  }
  try {
    await d.placeContactNow(db, { locationId, contactId: contact.id })
  } catch (e) {
    logWarn(LOG, 'board placement failed', { ...ids, errClass: e?.name })
  }
  try {
    // No un1t.online app section for a Glofox studio: appLinks stays null.
    await d.sendCorpPromoEmail(db, { claim: grantedRow, copy, studioName: location.name || '', zone, appLinks: null })
  } catch (e) {
    logWarn(LOG, 'confirmation email failed after the grant', { ...ids, errClass: e?.name })
  }
  return { kind: 'granted', credits: promo.credits, expiresAt: null }
}
