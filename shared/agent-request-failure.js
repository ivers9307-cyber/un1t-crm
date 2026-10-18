// AGENT-RETRY.1 / C85 (c) — what a FAILED agent-request execution's code
// means and what to fix before retrying, in the operator's words. Keyed on
// details.result.message_code (or .reason). Shared by the web (re-exported
// from src/lib/approvals/agent-request-why.js: the approvals provider, the
// decide card, the requests page) and the phone (mobile/lib/approval-outcome.js:
// the post-approve alert and the thread's approval card), which used to show
// the raw code. Staff-facing copy, no imports: pure.

const FAILURE_EXPLANATIONS = {
  YOU_HAVE_NO_CREDITS_LEFT:
    'Glofox refused the booking: no class credits on their account. Grant a credit in Glofox, then retry.',
  NOT_EXECUTABLE:
    'The request could not be executed: the contact has no linked Glofox account (or Glofox is not configured here). Link the account, then retry.',
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
  // or its rows named different trials. A bare retry re-reads the same rows,
  // so the copy leads with the fix that works: credits added by hand.
  TRIAL_PRODUCT_UNKNOWN:
    'Which trial this booking page offers could not be worked out (its booking records name two different trials, or could not be read), so no trial was bought and nothing was booked. Retrying alone will likely stop here again. Add a credit or membership in Glofox by hand, then retry and it books against it.',
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

/** Every code with its own sentence (the rest read "Glofox rejected the action (CODE)"). */
export const FAILURE_CODES = Object.freeze(Object.keys(FAILURE_EXPLANATIONS))
