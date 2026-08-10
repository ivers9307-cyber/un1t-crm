// contacts.email_status is REPUTATION, and reputation belongs to an
// ADDRESS — not to a person.
//
// mig 005 defines the column, mig 492/501 pin it to
// active | bounced | complained and label it "REPUTATION ONLY". A hard
// bounce or a spam complaint stamps it (postmark-webhook-processor), and
// every send path then refuses that contact:
//   • marketing + transactional audiences — postmark.js
//     buildAudienceQuery / buildAudienceQueryAsync
//   • the campaign sender — campaign-sender.js
//   • manual staff email — /api/contacts/[id]/email
//   • booking confirmations, event + attendee reminders
//
// Refusing a bounced address is CORRECT: the address is invalid, and
// hammering a dead mailbox is how a sending domain's reputation dies.
// It is correct for transactional mail too — a booking confirmation to
// a mailbox that does not exist is not a confirmation, and the
// transactional stream is the one whose deliverability we can least
// afford to spend.
//
// SILENT-FAIL: the flag went STALE. Nothing in the CRM reset it when the
// address itself CHANGED. Staff fix an operator typo on a contact, or an
// import supplies a corrected address, and the row keeps a `bounced`
// stamp that describes a mailbox the contact no longer has — so they are
// permanently unmailable on every channel above, with no UI symptom
// beyond a greyed-out button. The only ways it ever came off were a
// Postmark SubscriptionChange un-suppression (which needs Postmark to
// act, and Postmark knows nothing about a CRM-side edit) or a marketing
// opt-in through one of the unguarded preference routes.
//
// So: reset the reputation when — and only when — the address it refers
// to is replaced.
//
// This does NOT make an invalid address newly mailable for marketing.
// Marketing needs, on top of `email_status`:
//   • per-location consent (contact_location_audience.loc_email_marketing,
//     LOCCOMMS.3 — "row absent = that location may never send"), and the
//     hard-bounce handler revokes email_marketing at the same moment it
//     stamps 'bounced'; and
//   • email_suppressed_at IS NULL (mig 395).
// Neither is touched here, so a corrected address gets administrative
// mail back immediately and still needs a fresh opt-in before any
// marketing reaches it. Reputation is restored; consent is not.

/**
 * Addresses are compared case-insensitively and trimmed: contacts are
 * stored mixed-case (see the .ilike invariant in CLAUDE.md), so
 * re-saving 'Ann@x.com' as 'ann@x.com' is the SAME mailbox and must not
 * clear a genuine bounce.
 */
function normalise(addr) {
  return typeof addr === 'string' ? addr.trim().toLowerCase() : ''
}

/**
 * Reputation states that describe a specific mailbox and are therefore
 * void once the mailbox changes. Mirrors the guard the Postmark
 * reactivation path uses (`.in('email_status', [...])`) so neither can
 * rewrite an already-healthy row.
 */
export const ADDRESS_BOUND_EMAIL_STATUSES = Object.freeze(['bounced', 'complained'])

/**
 * Decide whether a contact's email_status must be cleared because the
 * address changed. Pure — callers fold the result into the SAME update
 * they were already writing, so the reset can never land without the
 * address change that justifies it (and costs no extra round trip).
 *
 * @param {object} args
 * @param {string|null|undefined} args.oldEmail        address before the write
 * @param {string|null|undefined} args.newEmail        address the write sets, or
 *   undefined when the write doesn't touch email
 * @param {string|null|undefined} args.currentStatus   contacts.email_status now
 * @returns {'active'|null} 'active' to include as email_status in the update,
 *   null to leave email_status alone.
 */
export function emailStatusResetForAddressChange({ oldEmail, newEmail, currentStatus }) {
  // The write doesn't set an address → nothing to reset. `null` is a
  // deliberate clear, which is still a change away from the bounced one.
  if (newEmail === undefined) return null
  const from = normalise(oldEmail)
  const to = normalise(newEmail)
  if (from === to) return null
  // Only reputation states are address-bound. 'active' / null stay as
  // they are; anything unrecognised is left alone rather than guessed at.
  if (!ADDRESS_BOUND_EMAIL_STATUSES.includes(currentStatus)) return null
  return 'active'
}
