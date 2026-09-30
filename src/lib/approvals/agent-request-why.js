import { hasBookableMembership } from '@/lib/person-accounts'
import { CLASS_BOOKING_MAX_ATTEMPTS } from '@/lib/class-booking-attempts'

// AGENT-REQ-UX.1 — operator-readable explanations for agent requests.
//
// `agent_membership_requests.details.reason` carries two very different
// things depending on the kind:
//   • class_booking — a MACHINE code written by the booking pipeline
//     (class-booking-processor routeToReview / MIA-BOOK fallback), e.g.
//     'prior_attendance', 'needs_credit_grant', 'booking_failed:<CODE>'.
//     Raw codes were rendered verbatim on the review surfaces, so the
//     operator saw `Reason: "prior_attendance"` with no idea what to do.
//   • pause / cancellation — the CUSTOMER's own words, captured by Mia's
//     tools ("The customer's reason for pausing, in their words").
//
// whyFlagged() translates only the machine codes (class_booking) into a
// what-happened + what-to-do line; everything else returns null so the
// caller renders the customer's words as a quote, never as a code.
//
// Operator-facing copy (staff review queue), not customer-facing — so
// hard-coded strings are fine here (the operator-editable-copy invariant
// covers what CUSTOMERS see).

const MACHINE_REASONS = {
  // AGENT-FUNNEL-CREDITS.1 — since the balance-aware pipeline, a returner
  // with credits or an active membership books automatically; this code now
  // means "attended before AND nothing on the account to book with".
  prior_attendance:
    'They have attended before and no usable balance was found (no class credits, no active membership) — the free intro does not apply. Grant a credit or set up a membership in Glofox, then approve to book.',
  // TRIALGRANT.1 — approving buys the trial first and judges the purchase;
  // if Glofox will not add it, nothing is booked and this card says why.
  needs_credit_grant:
    'Their Glofox account has no class credits left. Approving adds the trial in Glofox first, then books. If Glofox will not add the trial, nothing is booked and this card says why.',
  // MIA-CREDITS.1 — Mia's pre-flight found nothing to book with and handed
  // the thread to a human; this card carries the booking intent.
  no_credits:
    'Mia escalated: they asked to book but have no class credits or active membership. Talk to them in the conversation, grant a credit or set them up in Glofox, then approve to book.',
  account_ambiguous:
    'More than one Glofox account matched this customer. Pick the right account in Glofox before approving.',
  // PERSON-ACCT.7 — the agent elects ONE linked account per booking and
  // escalates instead of coin-flipping between two that are both live.
  account_conflict:
    'Mia found more than one account holding a live membership/credits and escalated rather than guess. Confirm which account is right in Glofox, then approve — the booking runs against the account shown.',
  // PERSON-ACCT.9 — the funnel could not read this person's other contact
  // rows, so it refused to mint a Glofox account it might be duplicating.
  account_check_failed:
    'Their other contact records could not be read, so no Glofox account was created (it might have been a duplicate). Check whether they already have an account, then approve to book.',
  account_failed:
    'Their Glofox account could not be found or created automatically. Sort the account in Glofox, then approve to book.',
  account_needs_review:
    'Their Glofox account match needs a human check. Confirm the account in Glofox, then approve to book.',
  attendance_check_failed:
    'Their attendance history could not be read from Glofox, so it was not auto-booked. Check the account and decide.',
  // CBPCREDITREAD.1 — the funnel could not READ their Glofox credit balance
  // on any of its attempts (class-booking-queue.js at MAX_ATTEMPTS; the
  // count in the copy is that same constant). The
  // balance is UNKNOWN, not empty, and approving grants nothing
  // (approvalGrantsTrialCredit below): staff add a credit themselves if one
  // is really missing.
  credit_check_failed:
    `Their Glofox credit balance could not be read (Glofox did not answer after ${CLASS_BOOKING_MAX_ATTEMPTS} tries), so the booking was not made. This does not mean they have no credits. Check their account in Glofox: if they have credits or a membership, approve to book against it. If they have none, add a credit in Glofox first, then approve. Approving does not add a credit.`,
  booking_rejected:
    'Glofox rejected the live booking attempt. Fix the account (credits / membership), then approve to retry the booking.',
  superseded_duplicate:
    'Duplicate of an earlier pending booking request for the same class.',
  // REGISTRYREAD.1a — the automatic booking THREW on every attempt
  // (class-booking-queue.js at MAX_ATTEMPTS). Nothing reached Glofox.
  processing_error:
    `The automatic booking failed ${CLASS_BOOKING_MAX_ATTEMPTS} times (for example, the studio's Glofox settings could not be read). Nothing was booked. Approve to book now.`,
  // REGISTRYREAD.1a — the cron's reaper found the row stuck mid-run past the
  // attempt cap. A run that died mid-flight may already have booked it.
  max_attempts_stuck_processing:
    `The automatic booking was interrupted ${CLASS_BOOKING_MAX_ATTEMPTS} times and never finished, so it may or may not have gone through. Check Glofox for the booking first; if it is not there, approve to book now.`,
}

// CBPCREDITREAD.1 — credit_check_failed names WHICH account's credits could
// not be read (details.credit_unread_accounts, written by the processor): the
// account the booking was for, or another account linked to the same person.
// By Glofox member ID only, which staff can look up in Glofox; no name, email
// or phone. A malformed list renders nothing extra.
function creditUnreadLine(accounts) {
  if (!Array.isArray(accounts)) return null
  const parts = accounts
    .filter((a) => a && typeof a.glofox_member_id === 'string' && a.glofox_member_id)
    .map((a) => (a.role === 'linked_account'
      ? `another Glofox account linked to this person (member ID ${a.glofox_member_id})`
      : `the Glofox account this booking was for (member ID ${a.glofox_member_id})`))
  return parts.length ? `Could not be read: ${parts.join('; ')}.` : null
}

// booking_failed:<CODE> — keep the Glofox message code visible but lead
// with plain English for the common case.
function bookingFailedExplanation(code) {
  if (code === 'YOU_HAVE_NO_CREDITS_LEFT') {
    return 'Glofox refused the automatic booking — no class credits left on their account. Grant a credit in Glofox, then approve to retry.'
  }
  return `Glofox refused the automatic booking (${code}). Fix the issue in Glofox, then approve to retry.`
}

/**
 * Why is this request sitting in the review queue? Returns an
 * operator-readable sentence for class_booking machine codes (and the
 * draft-mode default), or null when there is nothing mechanical to
 * explain (pause/cancel — the reason there is the customer's own words).
 */
const TRIAL_UNSETTLED_AT_MINT =
  'Their Glofox account was just created, but Glofox gave no clear answer when the trial was being added, so it may already be there. Approving books only if class credits show on the account, and will not buy a second trial. Check their account in Glofox for a €0 trial invoice; if there is none, add a credit by hand, then approve.'

export function whyFlagged(row) {
  if (!row || row.kind !== 'class_booking') return null
  const d = row.details || {}
  const reason = typeof d.reason === 'string' ? d.reason : null
  if (reason) {
    if (reason === 'credit_check_failed') {
      const line = creditUnreadLine(d.credit_unread_accounts)
      return line ? `${MACHINE_REASONS[reason]} ${line}` : MACHINE_REASONS[reason]
    }
    // GLOFOXPOSTRETRY.1 review — the account was just made, but the trial
    // purchase got no clear answer, so this card's approve will not buy one.
    if (reason === 'needs_credit_grant' && d.trial_grant?.outcome_unknown === true) return TRIAL_UNSETTLED_AT_MINT
    if (MACHINE_REASONS[reason]) return MACHINE_REASONS[reason]
    if (reason.startsWith('booking_failed:')) {
      return bookingFailedExplanation(reason.slice('booking_failed:'.length) || 'unknown')
    }
    if (reason.startsWith('account_')) {
      return `Their Glofox account could not be resolved automatically (${reason}). Sort the account in Glofox, then approve to book.`
    }
    // Unknown machine code — show it raw rather than hiding it.
    return `Flagged by the booking pipeline: ${reason}.`
  }
  // Mia's draft-mode bookings carry no reason — the flag IS the mode.
  if (d.mode === 'draft') {
    return 'Mia drafted this booking for staff confirmation (agent booking mode is set to draft). Approving books it in Glofox.'
  }
  return null
}

// CBPCREDITREAD.1 — the ONE card reason whose approval buys the trial
// membership before booking (membership-requests/[id]/route.js): a credits
// read that WORKED and found none on a never-attended account. Every other
// reason grants nothing, credit_check_failed above all (the balance is
// UNKNOWN, and the member may already hold a paid pack). Pure.
export function approvalGrantsTrialCredit(details) {
  return details?.reason === 'needs_credit_grant'
}

// AGENT-RETRY.1 — what a FAILED execution's Glofox code means and what to
// fix before retrying. Keyed on details.result.message_code.
const FAILURE_EXPLANATIONS = {
  YOU_HAVE_NO_CREDITS_LEFT:
    'Glofox refused the booking — no class credits on their account. Grant a credit in Glofox, then retry.',
  NOT_EXECUTABLE:
    'The request could not be executed — the contact has no linked Glofox account (or Glofox is not configured here). Link the account, then retry.',
  // PERSON-ACCT.7 — the row named the Glofox account the agent chose for this
  // booking, and the contact is now linked to a different one, so nothing was
  // booked (rather than booking on an account nobody picked).
  ACCOUNT_MISMATCH:
    'This booking was queued for a different Glofox account than the one the contact is linked to now, so it was not executed. Check which account is right in Glofox, then retry.',
  // CANCEL-FORM.5 — membership cancellation execution (auto-cancel toggle on).
  NO_END_DATE:
    'No machine-readable end date on this request, so Glofox was not called. Set the end date on the card and approve again, or cancel in Glofox by hand.',
  NO_USER_MEMBERSHIP:
    'Glofox returned no active membership for this account, so there was nothing to cancel. Check the membership in Glofox (it may already be cancelled or on another account), then retry.',
  // REGISTRYREAD.1a — the studio's Glofox settings could not be read when
  // staff approved (a database blip). Nothing reached Glofox.
  GLOFOX_SETTINGS_UNREADABLE:
    "The studio's Glofox settings could not be read (a temporary database error), so nothing was sent to Glofox. Retry.",
  // TRIALGRANT.1 — approving a needs_credit_grant card buys the trial before
  // booking (agent/trial-grant.js). These mean the trial was NOT added, so
  // the booking was never attempted.
  TRIAL_GRANT_FAILED:
    'Glofox would not add the trial credit, so the booking was not attempted. Check their account in Glofox: they may have had the trial before, or hold a membership the trial would only start after. Add a credit or membership by hand, then retry. If they have credits by then, retrying books against them and does not add another trial.',
  TRIAL_NOT_CONFIGURED:
    'No trial membership is set for this studio (Settings, Locations, Glofox Integration, Trial membership), so no trial was added and the booking was not attempted. Set it, or add a credit in Glofox by hand, then retry.',
  // Also: an earlier attempt started buying the trial and its result was
  // never recorded (the write-ahead marker, or Glofox never answered).
  TRIAL_GRANT_UNVERIFIED:
    'An earlier attempt may already have added the trial (its result was not recorded, or their credit balance could not be read), so no second trial was bought and nothing was booked. Check their account in Glofox for a €0 trial invoice. If the trial is there and usable, or you add a credit by hand, retry and it books against it.',
  // The approval could not write its "about to buy the trial" marker, so it
  // did not buy (a purchase with no record is what a retry could double).
  TRIAL_GRANT_UNRECORDED:
    'The approval could not save its progress before adding the trial (a temporary database error), so no trial was bought and nothing was booked. Retry in a minute.',
  // TRIALPURCHASE.2 — one trial per member, not per card: another card for
  // the same Glofox member already bought one (or may have), or the /start
  // mint bought it when it created the account (prior_push_event_id).
  TRIAL_ALREADY_GRANTED:
    'This member already got a free trial, from an earlier approval or when their account was made (or may have, if its result was unclear), so no second trial was bought and nothing was booked. Check their account in Glofox. If they should have this class, add a credit or membership by hand, then retry and it books against it.',
  TRIAL_HISTORY_UNREADABLE:
    'Whether this member already got a trial from an earlier approval could not be checked (a temporary database error), so no trial was bought and nothing was booked. Retry in a minute.',
  // The card named no trial, and the booking's queue row could not be read,
  // or its rows named different trials.
  TRIAL_PRODUCT_UNKNOWN:
    'Which trial this booking page offers could not be worked out (a temporary database error, or two different trials were named), so no trial was bought and nothing was booked. Retry in a minute. If it happens again, add a credit in Glofox by hand, then retry.',
}

// TRIALGRANT.1 — the trial was added a moment before, yet Glofox still
// refused for no credits. The purchase spec: a member with an active
// membership gets the new one starting AFTER it ends.
// Review of TRIALGRANT.1 — the purchase was sent but Glofox never answered
// clearly (network, or a 5xx: GLOFOXPOSTRETRY.1), so it may or may not have
// gone through.
const TRIAL_GRANT_NO_ANSWER =
  'Glofox did not answer clearly (no reply, or a server error) when the trial was being added, so it may or may not have gone through, and the booking was not attempted. Check their account in Glofox for a €0 trial invoice. If the trial is there and usable, or you add a credit by hand, retry and it books against it; retrying never buys a second trial while this is unclear.'

const NO_CREDITS_AFTER_TRIAL =
  'The trial was added in Glofox, but Glofox still refused the booking for no credits. The trial may be set to start later (Glofox starts a new membership after one they already hold ends). Check their memberships in Glofox, then retry. Retrying does not add another trial.'

/**
 * Operator-readable line for a failed execution, or null when the row is
 * not a failed execution. Pure.
 */
export function failureExplanation(row) {
  if (!row || row.status !== 'failed') return null
  const result = row.details?.result || {}
  const code = result.message_code || result.reason || null
  if (!code) return 'The execution failed. Check the account in Glofox, fix what is wrong, then retry.'
  if (code === 'TRIAL_GRANT_FAILED' && result.outcome_unknown === true) return TRIAL_GRANT_NO_ANSWER
  if (code === 'TRIAL_GRANT_FAILED') {
    const said = typeof result.glofox_message_code === 'string' && result.glofox_message_code
      ? ` Glofox said: ${result.glofox_message_code}.`
      : ''
    return `${FAILURE_EXPLANATIONS.TRIAL_GRANT_FAILED}${said}`
  }
  if (code === 'YOU_HAVE_NO_CREDITS_LEFT' && result.trial_grant?.ok === true && !result.trial_grant.skipped) {
    return NO_CREDITS_AFTER_TRIAL
  }
  return FAILURE_EXPLANATIONS[code]
    || `Glofox rejected the action (${code}). Fix the issue in Glofox, then retry.`
}

// PERSON-ACCT.3 — states that mean the membership (whatever its status)
// cannot book right now. glofox_membership_status is NEVER the string
// 'active' in prod (see person-accounts.js's hasBookableMembership for the
// live-DB distribution) — the previous `status !== 'active'` check always
// took this branch, so the STATE (paused/locked/future) was never surfaced
// and a paused/locked member rendered as if nothing were wrong.
const BLOCKING_STATE_LABELS = {
  future: 'not started',
  paused: 'paused',
  locked: 'locked',
}

// AGENT-FUNNEL-CREDITS.1 — one-line account summary for approval cards, from
// the membership fields the Glofox sync denormalises onto contacts. No live
// API call: this is what the CRM already knows, at last-sync freshness.
export function accountSummaryLine(contact) {
  if (!contact) return null
  const plan = contact.glofox_membership_plan || null
  const status = contact.glofox_membership_status || null
  const state = contact.glofox_membership_state || null
  const credits = contact.trial_credits_remaining
  const parts = []
  if (plan) {
    let qualifier = ''
    const blockerLabel = state ? BLOCKING_STATE_LABELS[state] : null
    if (blockerLabel) {
      // A real membership that just can't book RIGHT NOW — lead with the
      // status (when there is one) so staff see both facts, e.g.
      // "member, paused".
      qualifier = status ? `${status}, ${blockerLabel}` : blockerLabel
    } else if (!hasBookableMembership(contact)) {
      // Not a blocked state, but also not a genuine bookable membership
      // (trial, classpass_payg, lead, ...) — surface the status as-is.
      qualifier = status || ''
    }
    // else: a genuinely bookable membership (hasBookableMembership true,
    // no blocking state) — no qualifier, nothing for staff to act on.
    parts.push(qualifier ? `${plan} (${qualifier})` : plan)
  } else {
    parts.push('No membership on file')
  }
  if (Number.isFinite(credits)) parts.push(`${credits} credit${credits === 1 ? '' : 's'} left`)
  else parts.push('credits unknown')
  return parts.join(' · ')
}

/**
 * PERSON-ACCT.8 — pause/cancellation elect ONE of a person's linked
 * accounts and stamp `details.elected_glofox_member_id`, same convention
 * book_class uses. But class_booking's ACCOUNT_MISMATCH cross-check
 * (src/app/api/agent/membership-requests/[id]/route.js) is BLOCKING for a
 * reason that does not apply here: approving a class_booking re-runs a
 * live Glofox call, so a stale election would book the wrong account
 * silently, and refusing is strictly safer than executing. Pause and
 * cancellation are NOT in EXECUTING_KINDS (request-recovery.js) — staff
 * make the actual Glofox change by hand after approving (CANCEL-FORM.5:
 * unless the location's auto-cancel toggle is on, in which case the
 * executor itself honours details.elected_glofox_member_id, so a stale
 * election cancels the elected account rather than a silently wrong one). Blocking the DECISION
 * itself (approve/decline/save) here would only strand a legitimate
 * request behind a mismatch that may already be moot by the time staff
 * look at it (the account could have been fixed, merged, or re-synced
 * since the request was filed) — worse than the risk it guards against.
 * So this is a WARNING for the operator to double-check in Glofox, never a
 * refusal to decide. Pure — the card renders it, nothing calls it to gate
 * anything.
 */
export function accountMismatchWarning(row) {
  if (!row || (row.kind !== 'pause' && row.kind !== 'cancellation')) return null
  const elected = row.details?.elected_glofox_member_id || null
  const current = row.contact?.glofox_member_id || null
  if (!elected || !current || elected === current) return null
  return 'This request was filed against a different Glofox account than the one the contact is linked to now — check which account is right before making the change in Glofox.'
}

/**
 * The customer's own words, when captured. Prefer the explicit note; for
 * pause/cancellation the tools also write details.reason in the
 * customer's words. class_booking details.reason is a machine code and
 * must never be surfaced as a customer quote.
 */
export function customerWords(row) {
  if (!row) return null
  // Tolerate both spellings: DB rows carry customer_note, the /approvals
  // provider items carry customerNote.
  const rawNote = row.customer_note ?? row.customerNote
  const note = typeof rawNote === 'string' ? rawNote.trim() : ''
  if (note) return note
  if (row.kind === 'class_booking') return null
  const reason = row.details && typeof row.details.reason === 'string' ? row.details.reason.trim() : ''
  return reason || null
}
