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
/** While the list is asked for and unanswered — the modal disables Send on it. */
export const AWAITING_SENDER_FOOTER = 'Checking studio accounts…'
/** The list could not be loaded: says so, and says what the send will do. */
export const UNAVAILABLE_SENDER_FOOTER = 'Couldn’t load studio accounts — will send from the company address'

/**
 * The modal's mailbox state when listMail FAILED — distinct from [] ("the
 * studio has no account I may send as") so a transport blip or a route 500
 * is never rendered as the confident claim that no account exists. A string,
 * not an array, so nothing that .map/.find's a list can mistake it for one:
 * every reader below goes through Array.isArray first.
 */
export const MAILBOXES_UNAVAILABLE = 'unavailable'

/**
 * MAIL-403.1 — the list answered 403: the caller holds no Mail access at the
 * contact's studio. That is a PERMANENT permission state, not a failure, so it
 * gets its own footer — the generic "couldn't load" read as a fault to a coach
 * who simply isn't on that studio's Mail. Still the company path (the send
 * still goes out), still a string so no reader can .map it.
 */
export const MAILBOXES_FORBIDDEN = 'forbidden'

/** No Mail access at the contact's studio: says so, and says what the send will do. */
export const NO_ACCESS_SENDER_FOOTER = 'You don’t have Mail access at this studio — will send from the company address'

/**
 * listMail's answer → the modal's mailbox state: the array on success (null-
 * tolerant on the field, so a route that omits `mailboxes` reads as none),
 * MAILBOXES_UNAVAILABLE on any failure. Review fix: the effect used to map
 * every failure to [] — the company path with only an 11px footer claiming
 * the studio had no accounts, when the truth was that we never found out.
 *
 * What counts as "genuinely none" is ONLY a successful empty list. A refused
 * list (403: the caller lacks email_inbox at that studio) rides the same
 * {success:false,error} envelope as a route 500 and api() deliberately passes
 * that envelope through unchanged (no status field), so at this layer the two
 * cannot be told apart — both are "unavailable", which is honest for both:
 * the list was not obtained, the send goes company either way.
 */
export function mailboxesFromListResult(res) {
  // 403 is judged BEFORE the generic failure: it is the one failure that is a
  // state rather than a fault — the route answers it only for a caller with
  // no `email_inbox` at that studio. listMail passes api()'s `status` through.
  if (res?.status === 403) return MAILBOXES_FORBIDDEN
  if (!res?.success) return MAILBOXES_UNAVAILABLE
  return Array.isArray(res.mailboxes) ? res.mailboxes : []
}

/**
 * The visible-list row for `mailboxId`, or null. Anything that is not an
 * array (null = unanswered, MAILBOXES_UNAVAILABLE = failed) and a stale id
 * ("not ours to send as") all resolve to null; the callers decide what null
 * means from the other inputs.
 */
function chosenMailbox(mailboxes, mailboxId) {
  if (!Array.isArray(mailboxes) || !mailboxId) return null
  return mailboxes.find(m => m?.id === mailboxId) || null
}

/**
 * Is the list asked for and not yet answered? Only when BOTH contact fields
 * are present — those are exactly the conditions under which the modal's
 * effect calls listMail. Without them the list is never requested, null is
 * permanent, and "awaiting" would be a Send button disabled forever.
 */
function isAwaiting({ mailboxes, contactEmail, contactLocationId }) {
  return mailboxes == null && !!contactEmail && !!contactLocationId
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
 *   { path: 'company', reason?: 'unavailable' }
 *     — POST /api/contacts/[id]/email, unchanged from before. `reason` is set
 *       when the list failed to load: the send is the same, the footer is not.
 *   { path: 'awaiting' }
 *     — the list is asked for and unanswered. NOT a send: the modal disables
 *       Send on it. Review fix — this used to be `company`, so a tap that beat
 *       the list call went out as the company sender, the very bug the
 *       feature fixes, now timing-dependent.
 *
 * @param {object} args
 * @param {object[]|string|null} args.mailboxes  listMail's `mailboxes` via
 *   mailboxesFromListResult; null = unanswered; MAILBOXES_UNAVAILABLE = failed
 * @param {string|null}   args.mailboxId  the chosen From account
 * @param {string|null}   args.contactEmail
 * @param {string|null}   args.contactLocationId
 */
export function resolveContactEmailSend({ mailboxes, mailboxId, contactEmail, contactLocationId } = {}) {
  if (isAwaiting({ mailboxes, contactEmail, contactLocationId })) return { path: 'awaiting' }
  if (mailboxes === MAILBOXES_UNAVAILABLE) return { path: 'company', reason: 'unavailable' }
  if (mailboxes === MAILBOXES_FORBIDDEN) return { path: 'company', reason: 'forbidden' }
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
 * from on the Mail path, the checking wording while the list is unanswered,
 * the could-not-load wording when it failed, or the company wording. Takes
 * the SAME inputs as resolveContactEmailSend and derives from its answer, so
 * the two can never disagree — pinned case-by-case in mail-sender.test.js.
 */
export function contactEmailFooter(args = {}) {
  const plan = resolveContactEmailSend(args)
  if (plan.path === 'awaiting') return AWAITING_SENDER_FOOTER
  if (plan.path === 'mail') return mailboxDisplay(chosenMailbox(args.mailboxes, args.mailboxId))
  if (plan.reason === 'unavailable') return UNAVAILABLE_SENDER_FOOTER
  if (plan.reason === 'forbidden') return NO_ACCESS_SENDER_FOOTER
  return COMPANY_SENDER_FOOTER
}
