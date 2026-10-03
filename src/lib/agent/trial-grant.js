// TRIALGRANT.1 — the trial credit that approving a needs_credit_grant card
// buys BEFORE booking (src/app/api/agent/membership-requests/[id]/route.js).
//
// It used to be a purchaseGlofoxMembership() call whose result was never
// read, inside a try/catch that only console.warned, followed by the booking
// regardless. purchaseGlofoxMembership also called any 2xx a purchase, and
// Glofox 200s with success:false. 4 of the 16 funnel needs_credit_grant
// approvals in the 90 days to 30 Sep 2026 then failed
// YOU_HAVE_NO_CREDITS_LEFT, and none of those 4 accounts got the €0 trial
// invoice Glofox sends when a trial purchase goes through. Staff saw "no
// credits" with no hint that the grant itself had failed, and Fix & retry
// bought the trial again.
//
// In order:
//   1. a grant an earlier attempt RECORDED (details.trial_grant.ok, not a
//      skip) is not bought again: a retry after a booking failure never
//      stacks a trial;
//   2. credits already on the account (staff added one by hand, or an
//      earlier grant that was never recorded) → nothing is bought;
//   3. one trial per MEMBER, not per card (TRIALPURCHASE.2): another card at
//      this studio that bought a trial for the same Glofox member (or may
//      have: a marker or no clear answer) stops the purchase with
//      TRIAL_ALREADY_GRANTED, and the card goes to staff. Every grant this
//      helper records carries glofox_member_id so the next card can find it;
//      a failed read of the other cards is TRIAL_HISTORY_UNREADABLE. The
//      same goes for a trial the /start mint bought when it created the
//      account (a glofox_push_events 'created' row: prior_push_event_id);
//   4. the trial product: the funnel block's own trial when the card carries
//      one (details.trial_membership_id/trial_plan_code, as the mint path
//      buys), else the one on the class_booking_requests row that points at
//      this card (a reused card, or one filed before TRIALGRANT.1, carries
//      none: TRIALPURCHASE.2), else the location default via
//      readGlofoxConfig, where a failed read is GLOFOX_SETTINGS_UNREADABLE,
//      never "not configured". A queue row that cannot be read, or two that
//      disagree, is TRIAL_PRODUCT_UNKNOWN: never a guess at the default;
//   5. TRIALCLAIM.1 (C113) — an atomic claim: one live glofox_trial_claims
//      row per (studio, Glofox member) (mig 697's partial unique index). The
//      reads in 3 cannot stop two cards approved at the same instant (neither
//      has recorded anything yet); the claim can. Taken after the product is
//      known and before the marker. A claim held by another card or by a
//      seeded mint/old grant → TRIAL_ALREADY_GRANTED; one this card already
//      holds (a retry) → go on; a claim that cannot be written →
//      TRIAL_GRANT_UNRECORDED; a conflict whose holder cannot be read →
//      TRIAL_HISTORY_UNREADABLE. Never a purchase on an unknown claim state.
//      Released only when NOTHING can have been bought (the marker was not
//      written, or Glofox answered a clear refusal); a lost release leaves
//      the claim standing, so the next card stops for staff (closed);
//   6. write-ahead: details.trial_grant = { stage: 'purchasing' } is
//      recorded on THIS execution (the route's guarded `record`) before the
//      purchase, and its outcome after it, both before any booking. If the
//      marker cannot be written nothing is bought (TRIAL_GRANT_UNRECORDED);
//   7. the purchase is judged on its body (purchaseGlofoxMembership().ok).
// A marker with no outcome, or a purchase Glofox never answered
// (outcome_unknown), may have gone through: a later attempt books only if
// credits show, and otherwise refuses (TRIAL_GRANT_UNVERIFIED), since a trial
// queued behind a membership they hold shows no credits yet.
// A credits read that FAILS on a first approval still buys (the behaviour
// before; the card itself rests on a read that worked, CBPCREDITREAD.1). On a
// RETRY it refuses (TRIAL_GRANT_UNVERIFIED): the earlier attempt may have
// granted, and buying blind would stack a second trial.
//
// Never throws. Returns { proceed, grant, failure }:
//   grant   — stored on details.trial_grant (always set)
//   failure — the card's details.result when proceed is false; the route
//             then lands it on 'failed' WITHOUT a booking attempt or a
//             customer message.
import { fetchUserCreditsResult, purchaseGlofoxMembership } from '@/lib/glofox'
import { computeCreditsRemaining } from '@/lib/glofox-sync'
import { readGlofoxConfig } from '@/lib/connection-registry'
import { logError, logWarn } from '@/lib/log'

export const TRIAL_GRANT_FAILED = 'TRIAL_GRANT_FAILED'
export const TRIAL_NOT_CONFIGURED = 'TRIAL_NOT_CONFIGURED'
export const TRIAL_GRANT_UNVERIFIED = 'TRIAL_GRANT_UNVERIFIED'
export const TRIAL_GRANT_UNRECORDED = 'TRIAL_GRANT_UNRECORDED'
export const TRIAL_PRODUCT_UNKNOWN = 'TRIAL_PRODUCT_UNKNOWN'
export const TRIAL_ALREADY_GRANTED = 'TRIAL_ALREADY_GRANTED'
export const TRIAL_HISTORY_UNREADABLE = 'TRIAL_HISTORY_UNREADABLE'

// TRIALPURCHASE.2 (a) — the funnel trial named by the class_booking_requests
// row(s) that point at this card. { ok: false } on a failed read or when two
// rows name different trials; { ok: true, trial: null } when none names one
// (both ids, as everywhere else). Only rows at this studio count: a queue row
// from another location can never supply the trial.
async function queueRowTrial(db, approvalId, locationId) {
  if (!approvalId) return { ok: true, trial: null }
  const { data, error } = await db.from('class_booking_requests')
    .select('trial_membership_id, trial_plan_code')
    .eq('approval_request_id', approvalId)
    .eq('location_id', locationId)
    .limit(50)
  if (error) return { ok: false }
  const pairs = new Map()
  for (const r of data || []) {
    if (r?.trial_membership_id && r?.trial_plan_code) {
      pairs.set(`${r.trial_membership_id}\u0000${r.trial_plan_code}`, { membershipId: r.trial_membership_id, planCode: r.trial_plan_code })
    }
  }
  if (pairs.size > 1) return { ok: false }
  return { ok: true, trial: pairs.size ? [...pairs.values()][0] : null }
}

// TRIALPURCHASE.2 (d) — another card at this studio whose recorded grant
// bought a trial for this Glofox member, or may have (a 'purchasing' marker,
// or outcome_unknown). A grant that bought nothing (a refusal Glofox
// answered, a credits_present skip without doubt) does not count.
// { ok: false } on a failed read.
function grantMayHaveBought(g) {
  if (!g || typeof g !== 'object') return false
  if (g.stage === 'purchasing' || g.outcome_unknown === true) return true
  return g.ok === true && !g.skipped
}
async function trialOnAnotherCard(db, { locationId, memberId, requestId }) {
  let q = db.from('agent_membership_requests')
    .select('id, details')
    .eq('location_id', locationId)
    .eq('kind', 'class_booking')
    .contains('details', { trial_grant: { glofox_member_id: memberId } })
  if (requestId) q = q.neq('id', requestId)
  const { data, error } = await q.limit(50)
  if (error) return { ok: false }
  const prior = (data || []).find((r) => grantMayHaveBought(r?.details?.trial_grant))
  return { ok: true, priorId: prior?.id ?? null }
}

// A trial bought when the /start mint CREATED the account lives only in
// glofox_push_events, never on a card. status 'created' is written only on a
// create whose trial attached: every create path passes attachTrial (the
// public booking page, /start, events, race payments, lead provisioning,
// the backfill, a sequence step, the manual button, the Review-tab retry),
// and a trial that did not attach (refused, no clear answer, settings unread
// or unset) makes the row 'needs_review' instead. So a 'created' row for
// this member at this studio is a trial already bought. { ok: false } on a
// failed read.
async function trialAtMint(db, { locationId, memberId }) {
  if (!memberId) return { ok: true, eventId: null }
  const { data, error } = await db.from('glofox_push_events')
    .select('id')
    .eq('location_id', locationId)
    .eq('glofox_member_id', memberId)
    .eq('status', 'created')
    .limit(1)
  if (error) return { ok: false }
  return { ok: true, eventId: data?.[0]?.id ?? null }
}

// TRIALCLAIM.1 (C113) — the atomic claim (mig 697). { ok: true } when this
// card holds the live claim (just taken, or taken by an earlier attempt of
// the same card); otherwise { ok: false, code, extra }.
const CLAIMS = 'glofox_trial_claims'
async function claimTrial(db, { locationId, memberId, requestId, at }) {
  const { data, error } = await db.from(CLAIMS)
    .insert({ location_id: locationId, glofox_member_id: memberId, request_id: requestId, source: 'approval', claimed_at: at })
    .select('id')
    .single()
  if (!error && data?.id) return { ok: true, claimId: data.id }
  // Anything but the unique conflict (a database error, or the table not
  // there yet) is an unknown claim state: no purchase.
  if (error?.code !== '23505') return { ok: false, code: TRIAL_GRANT_UNRECORDED, err: error || null }
  const { data: held, error: readErr } = await db.from(CLAIMS)
    .select('id, request_id, push_event_id')
    .eq('location_id', locationId)
    .eq('glofox_member_id', memberId)
    .is('released_at', null)
    .limit(1)
  // The holder unreadable, or gone by now (released meanwhile): unknown.
  if (readErr || !held?.length) return { ok: false, code: TRIAL_HISTORY_UNREADABLE, err: readErr || null }
  const live = held[0]
  if (live.request_id && live.request_id === requestId) return { ok: true, claimId: live.id }
  return {
    ok: false,
    code: TRIAL_ALREADY_GRANTED,
    extra: {
      prior_claim_id: live.id,
      ...(live.request_id ? { prior_request_id: live.request_id } : {}),
      ...(live.push_event_id ? { prior_push_event_id: live.push_event_id } : {}),
    },
  }
}

// Only when nothing can have been bought. A release that does not land
// leaves the claim standing: the next card for this member stops on
// TRIAL_ALREADY_GRANTED and staff decide (closed, never a second trial).
async function releaseClaim(db, claimId, { reason, at, requestId }) {
  try {
    const { data, error } = await db.from(CLAIMS)
      .update({ released_at: at, release_reason: reason })
      .eq('id', claimId)
      .is('released_at', null)
      .select('id')
    if (!error && data?.length) return
  } catch { /* logged below */ }
  logWarn('trial-grant', 'trial claim not released; the next card for this member will stop for staff', { requestId, reason })
}

export async function grantTrialBeforeBooking(db, {
  creds, locationId, memberId, priorGrant = null, isRetry = false, requestId = null,
  trialOverride = null, record = null,
  now = () => new Date().toISOString(),
} = {}) {
  const at = now()
  // TRIALPURCHASE.2 (d): every grant recorded from here names the member, so
  // a later card for the same person can find it.
  const who = memberId ? { glofox_member_id: memberId } : {}
  const stop = (messageCode, extra = {}, err = null) => {
    // One structured line per grant that did not happen. The card id only:
    // no name, email, phone or member id.
    logError('trial-grant', 'trial grant did not happen; booking not attempted', {
      requestId,
      code: messageCode,
      glofoxCode: extra.glofox_message_code ?? null,
      httpStatus: extra.http_status ?? null,
      purchaseStatus: extra.purchase_status ?? null,
      ...(err ? { err } : {}),
    })
    return { proceed: false, grant: { ok: false, at, ...who, code: messageCode, ...extra }, failure: { ok: false, message_code: messageCode, ...extra } }
  }
  // Set once the 'purchasing' marker is on the row: from then on, a purchase
  // whose answer we never got may have gone through at Glofox.
  let purchaseStarted = false
  // TRIALCLAIM.1 — the live claim this attempt holds, once taken.
  let claimId = null
  const persist = async (trialGrant) => {
    if (typeof record !== 'function') return false
    try { return (await record(trialGrant)) === true } catch { return false }
  }
  try {
    // A recorded SKIP (credits_present) bought nothing, so it is re-checked:
    // the credits it found may be used or lapsed by the time of a retry.
    if (priorGrant?.ok === true && !priorGrant.skipped) return { proceed: true, grant: priorGrant, failure: null }

    // An earlier attempt STARTED a purchase and never recorded its answer
    // (the process died, or Glofox never replied): it may have gone through.
    const unsettled = priorGrant?.stage === 'purchasing' || priorGrant?.outcome_unknown === true

    const read = await fetchUserCreditsResult(creds, memberId)
    if (read?.ok) {
      if (computeCreditsRemaining(read.credits) > 0) {
        // After an unsettled purchase the doubt is kept on the skip: the
        // route's final write replaces details.trial_grant with this one.
        return { proceed: true, grant: { ok: true, at, ...who, skipped: 'credits_present', ...(unsettled ? { outcome_unknown: true } : {}) }, failure: null }
      }
    }
    // No usable credits (or an unreadable balance) after an unfinished
    // purchase: a trial queued behind a membership they already hold shows
    // no credits yet, so buying now could stack a second one. Staff check
    // Glofox for the €0 trial invoice instead.
    // outcome_unknown travels with the refusal for the same reason: without
    // it the NEXT retry would read a plain failure and buy.
    if (unsettled) return stop(TRIAL_GRANT_UNVERIFIED, { outcome_unknown: true })
    if (!read?.ok) {
      if (isRetry) return stop(TRIAL_GRANT_UNVERIFIED)
      logWarn('trial-grant', 'credits unreadable before the trial grant; buying as before', { requestId })
    }

    // TRIALPURCHASE.2 (d) — one trial per member. Another card at this studio
    // already bought one for this Glofox member (or may have): buying again
    // is the second free trial one person got from 3 cards on 23 Aug. Staff
    // decide instead; credits added by hand book on a retry (the check above).
    const other = await trialOnAnotherCard(db, { locationId, memberId, requestId })
    if (!other.ok) return stop(TRIAL_HISTORY_UNREADABLE)
    if (other.priorId) return stop(TRIAL_ALREADY_GRANTED, { prior_request_id: other.priorId })
    // ...or the mint that created their account bought it.
    const mint = await trialAtMint(db, { locationId, memberId })
    if (!mint.ok) return stop(TRIAL_HISTORY_UNREADABLE)
    if (mint.eventId) return stop(TRIAL_ALREADY_GRANTED, { prior_push_event_id: mint.eventId })

    // The funnel block's own trial (carried on the card) wins over the
    // location default, as it does on the mint path; only BOTH ids count.
    let trial = trialOverride?.membershipId && trialOverride?.planCode
      ? { membershipId: trialOverride.membershipId, planCode: trialOverride.planCode }
      : null
    if (!trial) {
      // TRIALPURCHASE.2 (a) — a card with no stamp (reused, or filed before
      // TRIALGRANT.1): the queue row pointing at it holds the funnel's trial.
      const fromQueue = await queueRowTrial(db, requestId, locationId)
      if (!fromQueue.ok) return stop(TRIAL_PRODUCT_UNKNOWN)
      trial = fromQueue.trial
    }
    if (!trial) {
      const { cfg, error } = await readGlofoxConfig(db, locationId)
      if (error) return stop('GLOFOX_SETTINGS_UNREADABLE')
      if (!cfg?.trial_membership_id || !cfg?.trial_plan_code) return stop(TRIAL_NOT_CONFIGURED)
      trial = { membershipId: cfg.trial_membership_id, planCode: cfg.trial_plan_code }
    }

    // TRIALCLAIM.1 (C113) — the atomic claim. Two cards for this member
    // approved together both passed the reads above; only one gets the
    // claim. No card id or member id: nothing to claim for, so no purchase.
    if (!requestId || !memberId) return stop(TRIAL_GRANT_UNRECORDED)
    const claim = await claimTrial(db, { locationId, memberId, requestId, at })
    if (!claim.ok) return stop(claim.code, claim.extra || {}, claim.err || null)
    claimId = claim.claimId

    // Write-ahead: the row says a purchase is under way BEFORE it starts, so
    // a death anywhere after this point leaves a marker a retry refuses to
    // buy over. No marker, no purchase (and the claim goes: nothing bought).
    if (!(await persist({ stage: 'purchasing', at, ...who }))) {
      await releaseClaim(db, claimId, { reason: 'marker_unrecorded', at, requestId })
      return stop(TRIAL_GRANT_UNRECORDED)
    }
    purchaseStarted = true

    const p = await purchaseGlofoxMembership(creds, memberId, trial.membershipId, trial.planCode)
    if (p?.ok) {
      const grant = { ok: true, at, ...who, purchase_status: p.purchase_status ?? null, invoice_id: p.invoice_id ?? null }
      // The outcome, before any booking. If this write is lost the marker
      // still stands, so a retry refuses rather than buys: log and go on.
      if (!(await persist(grant))) logWarn('trial-grant', 'trial granted but the outcome was not recorded; the purchasing marker stands', { requestId })
      return { proceed: true, grant, failure: null }
    }
    // No clear answer (a network error, http_status 0, or a 5xx, which
    // glofoxFetch no longer re-sends: GLOFOXPOSTRETRY.1): Glofox may have
    // processed it, so a retry must not buy blind, and the claim stands.
    const unknown = p?.outcome_unknown === true || p?.http_status === 0
    // A refusal Glofox answered bought nothing: the claim goes.
    if (!unknown) await releaseClaim(db, claimId, { reason: 'purchase_refused', at, requestId })
    return stop(TRIAL_GRANT_FAILED, {
      glofox_message_code: p?.message_code ?? null,
      http_status: p?.http_status ?? null,
      purchase_status: p?.purchase_status ?? null,
      ...(unknown ? { outcome_unknown: true } : {}),
    })
  } catch (e) {
    // A throw after the claim but before the purchase was sent bought
    // nothing: the claim goes. After it was sent, the claim stands.
    if (claimId && !purchaseStarted) await releaseClaim(db, claimId, { reason: 'stopped_before_purchase', at, requestId })
    return stop(TRIAL_GRANT_FAILED, {
      glofox_message_code: null, http_status: null, purchase_status: null, error: 'exception',
      ...(purchaseStarted ? { outcome_unknown: true } : {}),
    }, e)
  }
}
