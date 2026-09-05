// MAIL-ARCH.2 — the Mail surface's VOCABULARY, in the one place both apps can
// reach. Lifted verbatim from src/components/mail/mail-display.js (MAIL-TRIAL.B
// onward), which now re-exports it, and consumed by mobile/lib/email-tickets.js
// in place of the hand-mirrored copy that had drifted.
//
// WHY shared/ AND NOT A SECOND COPY. The web rows and the mobile rows come off
// the SAME routes (/api/email/mail and its digest), which stamp `archived`,
// `needs_reply`, `unread` and `is_spam` on every conversation so that no client
// re-derives the predicates this surface exists to keep. Two hand-written
// readings of those stamps had already disagreed once: mobile's archive swipe
// OR-ed the ticket-era `status` back into the decision, so a legacy `solved`
// row the server calls LIVE (`archived:false`) was presented as archived and
// the swipe sent `{archived:false}` — a reopen of a conversation that was
// never closed. One implementation, two import paths (`@/lib/mail-vocabulary`
// on web, `shared/mail-vocabulary` on mobile) makes that drift impossible by
// construction; tests/shared-pair-sync.test.js asserts the web binding IS this
// object.
//
// Everything here is pure: no DOM, no fetch, no clock, no React Native. It
// runs under vitest's node environment and inside the Metro bundle alike.
//
// WHY A SEPARATE VOCABULARY FROM src/lib/ticket-display.js
// It is not a separate vocabulary for the same things: the shared helpers
// (requesterLabel, initialsOf, relativeTime, mailboxLabel, messageKind,
// deliveryMeta, …) are imported and reused wherever the two surfaces mean the
// same thing, and nothing here restates one. What lives here is only what the
// Mail surface means DIFFERENTLY — five views instead of the ticket queue's,
// two states instead of four, "Archived" where the data says `closed`.

// The two states a conversation can be in, on screen. `closed` is the word on
// disk (email_tickets.status); "Archived" is the word everywhere a person can
// read it. One lifecycle, two vocabularies — never a second column.
export const ARCHIVED_STATUS = 'closed'

/**
 * Is this conversation archived?
 *
 * Reads the flag the list route stamped, falling back to the raw status so a
 * row that arrived from somewhere else (an archive response, a thread re-read)
 * still answers correctly. The fallback is the same predicate the server used
 * (src/app/api/email/mail/_helpers.js isArchived: `status === 'closed'`, and
 * legacy `solved` is LIVE there by explicit decision), which is why it is one
 * line and not a rule.
 *
 * 🔴 THE SERVER STAMP BEATS STATUS RE-DERIVATION. When `archived` is a boolean
 * it is the whole answer; `status` is never OR-ed back in. That OR is exactly
 * the half-alive swipe-reopen bug this module exists downstream of.
 */
export function isArchived(conversation) {
  if (typeof conversation?.archived === 'boolean') return conversation.archived
  return conversation?.status === ARCHIVED_STATUS
}

/**
 * Has this member been answered?
 *
 * 🔴 THE ONE THING THE TICKET MODEL HAD THAT A MAIL CLIENT DOES NOT, and the
 * reason this surface keeps a derived predicate at all. Gmail can tell you
 * there is mail; it cannot tell you whether anybody replied to it.
 *
 * The value is the server's — stamped on every list row from the same
 * definition the `needs_reply` filter uses (isNeedsReply / scopeToNeedsReply in
 * the route helpers). The fallback exists for rows that did not come from the
 * list, and is deliberately the identical expression rather than a second
 * interpretation of it.
 */
export function needsReply(conversation) {
  if (typeof conversation?.needs_reply === 'boolean') return conversation.needs_reply
  return conversation?.status === 'open' && conversation?.last_message_direction === 'inbound'
}

/** Unread = at least one inbound message nobody has opened (mig 575's seen_at). */
export function isUnread(conversation) {
  return !!conversation?.unread
}

/**
 * Is this conversation quarantined as spam? (MAIL-SPAM.1, mig 584)
 *
 * `is_spam` is the server's flag, orthogonal to `status`: a quarantined
 * conversation keeps whatever lifecycle state it has and is simply excluded
 * from every view but Spam. `=== true`, not truthiness, so a row from before
 * the column existed (or a fixture that never set it) reads as live — the
 * same fail-open reading the server's isNeedsReply takes.
 */
export function isSpam(conversation) {
  return conversation?.is_spam === true
}

// The filter strip. No `unassigned` and no `mine`: those are assignment
// views, and assignment is the half of the ticket model this surface drops.
// MAIL-SENT.1 added Sent; MAIL-SPAM.1 added Spam (the quarantine).
//
// Each view carries its own empty copy, because "nothing here" means three
// completely different things — an inbox that is genuinely clear is good news,
// an empty needs-reply list is the goal, and an empty archive just means
// nothing has been filed yet.
//
// The ids are the WIRE contract: the mail route 400s on a `view` it does not
// know, and src/app/api/email/mail/_helpers.js's MAIL_VIEWS is the server's
// own list of the same ids — tests/mail-vocabulary-agreement.test.js pins the
// two lists equal so a view added on one side cannot be missing on the other.
export const MAIL_VIEWS = Object.freeze([
  {
    id: 'inbox',
    label: 'Inbox',
    // MAIL-SENT.1 — the traditional split: Inbox holds conversations that
    // have RECEIVED something; outbound-only threads live on Sent until a
    // reply arrives.
    hint: 'Conversations that have received mail',
    emptyTitle: 'Inbox zero',
    emptyDescription: 'Nothing is waiting here. Outbound-only conversations are on the Sent tab; archived ones on Archived.',
  },
  {
    id: 'needs_reply',
    label: 'Needs reply',
    hint: 'They wrote to us and nobody has answered yet',
    emptyTitle: 'Everyone has been answered',
    emptyDescription: 'No conversation is waiting on a reply from the studio.',
  },
  {
    id: 'sent',
    label: 'Sent',
    hint: 'Sent by the studio, no reply yet — a reply moves the conversation to Inbox',
    emptyTitle: 'Nothing waiting on a reply',
    emptyDescription: 'Outbound-only conversations live here. The moment someone replies, the thread moves to Inbox.',
  },
  {
    id: 'archived',
    label: 'Archived',
    hint: 'Filed away — replying brings a conversation back',
    emptyTitle: 'Nothing archived yet',
    emptyDescription: 'Archiving a conversation files it here. It is never deleted.',
  },
  {
    // MAIL-SPAM.1 — the quarantine. Rows flagged is_spam at ingest (Postmark's
    // SpamScore at or above the studio's threshold) or by an operator. The
    // ONLY view that shows them; "Not spam" releases one back to Inbox. Kept
    // 30 days from the flag, then purged.
    id: 'spam',
    label: 'Spam',
    hint: 'Caught by the spam filter — Not spam releases a conversation to Inbox',
    emptyTitle: 'No spam',
    emptyDescription: 'Mail the filter catches waits here for 30 days in case it was real, then it is deleted. Nothing here counts towards the badge or pings anyone.',
  },
])

export const DEFAULT_MAIL_VIEW = 'inbox'

/** The view, or the default — never undefined, so no caller has to guard. */
export function mailView(id) {
  return MAIL_VIEWS.find(v => v.id === id) || MAIL_VIEWS[0]
}
