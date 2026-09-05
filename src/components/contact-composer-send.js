// MAIL-FOLLOWUPS.1 — who a contact-card email goes out as, on WEB.
//
// The web twin of mobile/lib/mail-sender.js (MOBILE-MAILPARITY.1), whose
// review found the race this file closes: ContactComposer's Send was disabled
// only on `!ready || sending`, and while the mailbox list was still loading
// (`mailboxes === null`) the inline resolver answered "company" — so a fast
// click sent as the COMPANY sender, the very bug PROFILE-MAIL.1 fixed, made
// timing-dependent. And every list failure (transport, route 500, non-JSON)
// collapsed to [] → company, with an 11px footer confidently claiming the
// studio had no accounts when the truth was that we never found out.
//
// Pure on purpose: the composer's render harness (ContactComposer.mail.test.jsx)
// pins the wiring, but the one decision that changes the From line a member
// reads lives here and is pinned case-by-case in contact-composer-send.test.js.
// Two functions, one rule between them — the footer the operator reads and the
// path the send takes derive from the SAME inputs, so the composer can never
// say "company" while composing from an account or the reverse.
//
// The mailbox list arrives from GET /api/email/mail?location_id=… (the same
// call the Mail compose sheet makes); the default id is the account starred
// Default on the studio's Email settings card, else the first visible one.

/** The company-path footer, word for word what the card has always shown. */
export const COMPANY_SENDER_FOOTER = 'Sent from the company address'
/** While the list is asked for and unanswered — the composer disables Send on it. */
export const AWAITING_SENDER_FOOTER = 'Checking studio accounts…'
/** The list could not be loaded: says so, and says what the send will do. */
export const UNAVAILABLE_SENDER_FOOTER = 'Couldn’t load studio accounts — will send from the company address'

/**
 * The composer's mailbox state when the list FAILED — distinct from [] ("the
 * studio has no account I may send as") so a transport blip or a route 500 is
 * never rendered as the confident claim that no account exists. A string, not
 * an array, so nothing that .map/.find's a list can mistake it for one: every
 * reader below goes through Array.isArray first.
 */
export const MAILBOXES_UNAVAILABLE = 'unavailable'

/**
 * The fetch answer → the composer's mailbox state: the array on a 2xx
 * `{ success: true, data: { mailboxes } }` envelope (null-tolerant on the
 * field, so a route that omits it reads as none), MAILBOXES_UNAVAILABLE on
 * anything else — a non-2xx, `success: false`, an unparseable body, no answer.
 *
 * What counts as "genuinely none" is ONLY a successful empty list. A refused
 * list (403: the caller lacks email_inbox at that studio) and a route 500 both
 * land here as "unavailable", which is honest for both: the list was not
 * obtained, the send goes company either way, and the footer says why.
 *
 * @param {{ ok: boolean, json: object|null } | null | undefined} res
 */
export function mailboxesFromListResponse(res) {
  if (!res?.ok || !res.json?.success) return MAILBOXES_UNAVAILABLE
  const boxes = res.json.data?.mailboxes
  return Array.isArray(boxes) ? boxes : []
}

/**
 * The account starred Default on the studio's Email settings card
 * (is_default), else the first visible one; null for an empty or non-list
 * (unanswered, unavailable).
 */
export function defaultMailboxId(mailboxes) {
  if (!Array.isArray(mailboxes)) return null
  return mailboxes.find(m => m?.is_default)?.id || mailboxes[0]?.id || null
}

/**
 * The visible-list row for `mailboxId`, or null. Anything that is not an
 * array (null = unanswered, MAILBOXES_UNAVAILABLE = failed) and a stale id
 * ("not ours to send as") all resolve to null.
 */
function chosenMailbox(mailboxes, mailboxId) {
  if (!Array.isArray(mailboxes) || !mailboxId) return null
  return mailboxes.find(m => m?.id === mailboxId) || null
}

/**
 * Is the list asked for and not yet answered? Only when BOTH contact fields
 * are present — those are exactly the conditions under which the composer's
 * effect fetches the list. Without them the list is never requested, null is
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
 *     — POST /api/email/tickets/compose. `locationId` is the MAILBOX'S studio
 *       (the mailbox decides the location, exactly as the route does),
 *       falling back to the contact's when the row carries no stamp.
 *   { path: 'company', reason?: 'unavailable' }
 *     — POST /api/contacts/[id]/email, unchanged from before. `reason` is set
 *       when the list failed to load: the send is the same, the footer is not.
 *   { path: 'awaiting' }
 *     — the list is asked for and unanswered. NOT a send: the composer
 *       disables Send on it, so a click that beats the list call can never go
 *       out as the company sender because the network was slow.
 *
 * @param {object} args
 * @param {object[]|string|null} args.mailboxes  via mailboxesFromListResponse;
 *   null = unanswered; MAILBOXES_UNAVAILABLE = failed
 * @param {string|null} args.mailboxId  the chosen From account
 * @param {string|null} args.contactEmail
 * @param {string|null} args.contactLocationId
 */
export function resolveContactEmailSend({ mailboxes, mailboxId, contactEmail, contactLocationId } = {}) {
  if (isAwaiting({ mailboxes, contactEmail, contactLocationId })) return { path: 'awaiting' }
  if (mailboxes === MAILBOXES_UNAVAILABLE) return { path: 'company', reason: 'unavailable' }
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
 * from on the Mail path (the composer renders the From picker there instead),
 * the checking wording while the list is unanswered, the could-not-load
 * wording when it failed, or the company wording. Takes the SAME inputs as
 * resolveContactEmailSend and derives from its answer, so the two can never
 * disagree.
 */
export function contactEmailFooter(args = {}) {
  const plan = resolveContactEmailSend(args)
  if (plan.path === 'awaiting') return AWAITING_SENDER_FOOTER
  if (plan.path === 'mail') {
    const m = chosenMailbox(args.mailboxes, args.mailboxId)
    return m.address || m.label || ''
  }
  return plan.reason === 'unavailable' ? UNAVAILABLE_SENDER_FOOTER : COMPANY_SENDER_FOOTER
}
