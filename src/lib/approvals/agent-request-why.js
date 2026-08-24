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
  prior_attendance:
    'They have attended a class before, so the free intro-class auto-booking does not apply. Check their account in Glofox and decide.',
  needs_credit_grant:
    'Their Glofox account has no class credits left. Approving grants the trial credit and completes the booking automatically.',
  account_ambiguous:
    'More than one Glofox account matched this customer. Pick the right account in Glofox before approving.',
  account_failed:
    'Their Glofox account could not be found or created automatically. Sort the account in Glofox, then approve to book.',
  account_needs_review:
    'Their Glofox account match needs a human check. Confirm the account in Glofox, then approve to book.',
  attendance_check_failed:
    'Their attendance history could not be read from Glofox, so it was not auto-booked. Check the account and decide.',
  booking_rejected:
    'Glofox rejected the live booking attempt. Fix the account (credits / membership), then approve to retry the booking.',
  superseded_duplicate:
    'Duplicate of an earlier pending booking request for the same class.',
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
export function whyFlagged(row) {
  if (!row || row.kind !== 'class_booking') return null
  const d = row.details || {}
  const reason = typeof d.reason === 'string' ? d.reason : null
  if (reason) {
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

// AGENT-RETRY.1 — what a FAILED execution's Glofox code means and what to
// fix before retrying. Keyed on details.result.message_code.
const FAILURE_EXPLANATIONS = {
  YOU_HAVE_NO_CREDITS_LEFT:
    'Glofox refused the booking — no class credits on their account. Grant a credit in Glofox, then retry.',
  NOT_EXECUTABLE:
    'The request could not be executed — the contact has no linked Glofox account (or Glofox is not configured here). Link the account, then retry.',
}

/**
 * Operator-readable line for a failed execution, or null when the row is
 * not a failed execution. Pure.
 */
export function failureExplanation(row) {
  if (!row || row.status !== 'failed') return null
  const code = row.details?.result?.message_code || row.details?.result?.reason || null
  if (!code) return 'The execution failed. Check the account in Glofox, fix what is wrong, then retry.'
  return FAILURE_EXPLANATIONS[code]
    || `Glofox rejected the action (${code}). Fix the issue in Glofox, then retry.`
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
