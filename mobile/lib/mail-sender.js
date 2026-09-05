// MOBILE-MAILPARITY.1 — who a contact-card email goes out as.
//
// The web ContactComposer (PROFILE-MAIL.1) is the reference: with a usable
// studio account at the CONTACT'S location, "Email" from the card IS a Mail
// compose — it goes out from that address, the reply threads back into a
// conversation filed at the mailbox's studio. Only with no usable account does
// it fall back to the one-off company sender (POST /api/contacts/[id]/email),
// which is what the phone did unconditionally until this file existed.
//
// Pure on purpose: the modal that renders it has no test harness, so the one
// decision that changes the From line a member reads lives here and runs under
// vitest (mail-sender.test.js). Two functions, one rule between them — the
// footer the operator reads and the path the send takes are derived from the
// SAME inputs, so the modal can never say "company" while composing from an
// account or the reverse.
//
// The mailbox list arrives from listMail (GET /api/email/mail?location_id=…);
// the default id from defaultMailboxId() in mail-compose.js — the same
// is_default-else-first rule the compose sheet and the web card both apply.
// No React Native imports — this file runs under vitest's node environment.

import { mailboxDisplay } from './mail-compose'

/** The company-path footer, word for word what the web card shows. */
export const COMPANY_SENDER_FOOTER = 'Sent from the company address'

/**
 * The visible-list row for `mailboxId`, or null. A null list is "not yet
 * answered" and a stale id is "not ours to send as": both resolve to null,
 * and null is the company path everywhere below.
 */
function chosenMailbox(mailboxes, mailboxId) {
  if (!Array.isArray(mailboxes) || !mailboxId) return null
  return mailboxes.find(m => m?.id === mailboxId) || null
}

/**
 * Which path a contact-card email takes, and the compose arguments if it is
 * the Mail one.
 *
 *   { path: 'mail', mailboxId, to: [contactEmail], locationId }
 *     — POST /api/email/tickets/compose. `locationId` is the MAILBOX'S
 *       studio (the mailbox decides the location, exactly as the route
 *       does), falling back to the contact's when the row carries no stamp
 *       (single-location list rows do not).
 *   { path: 'company' }
 *     — POST /api/contacts/[id]/email, unchanged from before.
 *
 * @param {object} args
 * @param {object[]|null} args.mailboxes  listMail's `mailboxes`; null = unanswered
 * @param {string|null}   args.mailboxId  the chosen From account
 * @param {string|null}   args.contactEmail
 * @param {string|null}   args.contactLocationId
 */
export function resolveContactEmailSend({ mailboxes, mailboxId, contactEmail, contactLocationId } = {}) {
  const mailbox = chosenMailbox(mailboxes, mailboxId)
  if (!mailbox || !contactEmail) return { path: 'company' }
  return {
    path: 'mail',
    mailboxId: mailbox.id,
    to: [contactEmail],
    locationId: mailbox.location_id || contactLocationId || null,
  }
}

/**
 * The one-line claim under the Send button: the address the member will hear
 * from on the Mail path, or the company wording. Derived from the same inputs
 * as resolveContactEmailSend, so it is company exactly when the send is.
 */
export function contactEmailFooter({ mailboxes, mailboxId } = {}) {
  const mailbox = chosenMailbox(mailboxes, mailboxId)
  return mailbox ? mailboxDisplay(mailbox) : COMPANY_SENDER_FOOTER
}
