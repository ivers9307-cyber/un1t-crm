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
//   3. the trial product is read with readGlofoxConfig: a failed read is
//      GLOFOX_SETTINGS_UNREADABLE, never "not configured";
//   4. the purchase is judged on its body (purchaseGlofoxMembership().ok).
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

export async function grantTrialBeforeBooking(db, {
  creds, locationId, memberId, priorGrant = null, isRetry = false, requestId = null,
  now = () => new Date().toISOString(),
} = {}) {
  const at = now()
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
    return { proceed: false, grant: { ok: false, at, code: messageCode, ...extra }, failure: { ok: false, message_code: messageCode, ...extra } }
  }
  try {
    // A recorded SKIP (credits_present) bought nothing, so it is re-checked:
    // the credits it found may be used or lapsed by the time of a retry.
    if (priorGrant?.ok === true && !priorGrant.skipped) return { proceed: true, grant: priorGrant, failure: null }

    const read = await fetchUserCreditsResult(creds, memberId)
    if (read?.ok) {
      if (computeCreditsRemaining(read.credits) > 0) {
        return { proceed: true, grant: { ok: true, at, skipped: 'credits_present' }, failure: null }
      }
    } else if (isRetry) {
      return stop(TRIAL_GRANT_UNVERIFIED)
    } else {
      logWarn('trial-grant', 'credits unreadable before the trial grant; buying as before', { requestId })
    }

    const { cfg, error } = await readGlofoxConfig(db, locationId)
    if (error) return stop('GLOFOX_SETTINGS_UNREADABLE')
    if (!cfg?.trial_membership_id || !cfg?.trial_plan_code) return stop(TRIAL_NOT_CONFIGURED)

    const p = await purchaseGlofoxMembership(creds, memberId, cfg.trial_membership_id, cfg.trial_plan_code)
    if (p?.ok) {
      return { proceed: true, grant: { ok: true, at, purchase_status: p.purchase_status ?? null, invoice_id: p.invoice_id ?? null }, failure: null }
    }
    return stop(TRIAL_GRANT_FAILED, {
      glofox_message_code: p?.message_code ?? null,
      http_status: p?.http_status ?? null,
      purchase_status: p?.purchase_status ?? null,
    })
  } catch (e) {
    return stop(TRIAL_GRANT_FAILED, { glofox_message_code: null, http_status: null, purchase_status: null, error: 'exception' }, e)
  }
}
