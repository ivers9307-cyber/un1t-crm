// MAIL-TRIAL.B — the pure half of the Mail surface: its vocabulary, its views,
// its URL and the two keyboard helpers.
//
// Everything here is pure (no DOM beyond a tag name, no fetch, no clock) so the
// decisions an operator actually feels — which filter they are on, what an
// empty screen says, whether `e` archives or types the letter e — are
// unit-testable without rendering anything.
//
// WHY A SEPARATE VOCABULARY FROM src/lib/ticket-display.js
// It is not a separate vocabulary for the same things: the shared helpers
// (requesterLabel, initialsOf, relativeTime, mailboxLabel, messageKind,
// deliveryMeta, …) are imported and reused wherever the two surfaces mean the
// same thing, and nothing here restates one. What lives here is only what the
// Mail surface means DIFFERENTLY — three views instead of five, two states
// instead of four, "Archived" where the data says `closed`.

// The two states a conversation can be in, on screen. `closed` is the word on
// disk (email_tickets.status); "Archived" is the word everywhere a person can
// read it. One lifecycle, two vocabularies — never a second column.
export const ARCHIVED_STATUS = 'closed'

/**
 * Is this conversation archived?
 *
 * Reads the flag the list route stamped, falling back to the raw status so a
 * row that arrived from somewhere else (an archive response, a thread re-read)
 * still answers correctly. The fallback is the same predicate the server used,
 * which is why it is one line and not a rule.
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

// The filter strip. THREE, not five: `unassigned` and `mine` are assignment
// views, and assignment is the half of the ticket model this surface drops.
//
// Each view carries its own empty copy, because "nothing here" means three
// completely different things — an inbox that is genuinely clear is good news,
// an empty needs-reply list is the goal, and an empty archive just means
// nothing has been filed yet.
export const MAIL_VIEWS = Object.freeze([
  {
    id: 'inbox',
    label: 'Inbox',
    hint: 'Everything that has not been archived',
    emptyTitle: 'Inbox zero',
    emptyDescription: 'Nothing is waiting here. Archived conversations are still on the Archived tab.',
  },
  {
    id: 'needs_reply',
    label: 'Needs reply',
    hint: 'They wrote to us and nobody has answered yet',
    emptyTitle: 'Everyone has been answered',
    emptyDescription: 'No conversation is waiting on a reply from the studio.',
  },
  {
    id: 'archived',
    label: 'Archived',
    hint: 'Filed away — replying brings a conversation back',
    emptyTitle: 'Nothing archived yet',
    emptyDescription: 'Archiving a conversation files it here. It is never deleted.',
  },
])

export const DEFAULT_MAIL_VIEW = 'inbox'

/** The view, or the default — never undefined, so no caller has to guard. */
export function mailView(id) {
  return MAIL_VIEWS.find(v => v.id === id) || MAIL_VIEWS[0]
}

/**
 * The list URL.
 *
 * Built here rather than interpolated at the call site because `view` is a WIRE
 * contract (the route 400s on anything it does not know) rather than free text,
 * and because the paging cursor has to be dropped whenever the scope changes —
 * a `before` carried across a filter switch would open the second page of a
 * list nobody has seen the first page of.
 *
 * `q` is the search term (Task 3's route param) and is appended ONLY when
 * non-empty — `q=` with nothing after it would ask the route to search for
 * nothing rather than not search at all, which is a different query.
 */
export function buildMailUrl({ locationId, mailboxId, viewId, before, q } = {}) {
  const params = new URLSearchParams()
  if (locationId) params.set('location_id', locationId)
  if (mailboxId) params.set('mailbox_id', mailboxId)
  // 'inbox' is the route's own default; sending it would only make two URLs
  // for one list, which matters because the URL is the cache key for a re-read.
  if (viewId && viewId !== DEFAULT_MAIL_VIEW) params.set('view', viewId)
  if (before) params.set('before', before)
  if (q) params.set('q', q)
  return `/api/email/mail?${params.toString()}`
}

// ── Keyboard ─────────────────────────────────────────────────────────
//
// The cheap ones only, and every one of them a letter a mail user already
// knows: j/k move, e archives, u goes back to the list. Deliberately no chords
// and no rebinding — a shortcut nobody can discover is worse than no shortcut,
// so these are printed on the surface itself, and the list is the SAME list
// the handler switches on so the two cannot drift.
//
// There is no Enter, on purpose: with a reading pane, j and k open the
// conversation they move to, so an "open" key would have nothing left to do.
export const MAIL_SHORTCUTS = Object.freeze([
  { keys: 'j / k', description: 'Next / previous conversation' },
  { keys: 'e', description: 'Archive (or bring back)' },
  { keys: 'u', description: 'Back to the list' },
])

const TYPING_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT'])

/**
 * Is the operator typing?
 *
 * 🔴 THE GUARD IS THE WHOLE FEATURE. A single-letter shortcut over a surface
 * whose main control is a composer means `e` either archives a conversation or
 * types the letter e into a half-written reply, and getting that backwards
 * loses somebody's draft. Tag name AND contentEditable, because a rich-text
 * host is neither an input nor a textarea.
 */
export function isTypingTarget(el) {
  if (!el) return false
  if (TYPING_TAGS.has(el.tagName)) return true
  if (el.isContentEditable === true) return true
  // 🔴 A DIALOG IS A TYPING CONTEXT BEFORE ANY FIELD IN IT HAS FOCUS. Modal
  // opens by focusing its own panel — a `<div role="dialog" tabIndex={-1}>` —
  // and neither the compose nor the forward form autofocuses a field. So the
  // operator's FIRST keystroke into a fresh compose window has that DIV as its
  // target: not an input, not contentEditable, and therefore not "typing" by
  // the two checks above. Typing a recipient beginning with `e` archived the
  // conversation behind the modal and moved the real Gmail message, while the
  // letter never reached the box.
  //
  // Checked by ROLE rather than by this surface's own modal state so it holds
  // for any dialog, including ones added later by someone who never reads this
  // file. The caller ALSO guards on its own state — belt and braces, because
  // the cost of being wrong here is a customer's mail moving without being asked.
  if (typeof el.closest === 'function' && el.closest('[role="dialog"]')) return true
  return false
}

/**
 * The id j/k should move to, or null when the move is not available.
 *
 * Returns null at both ends rather than wrapping: wrapping a list jumps an
 * operator from the oldest conversation to the newest with no visible cause,
 * and on a paged list the "end" is only the end of what has been loaded.
 * With nothing selected, the first item is the answer either way — that is
 * what makes j the natural first keystroke on a fresh screen.
 */
export function neighbourId(ids, currentId, delta) {
  const list = Array.isArray(ids) ? ids : []
  if (list.length === 0) return null
  const at = list.indexOf(currentId)
  if (at === -1) return list[0]
  const next = at + delta
  if (next < 0 || next >= list.length) return null
  return list[next]
}

/* ─────────────────────────── row density ─────────────────────────── */

/**
 * MAIL-DENSITY.1 — how much of a conversation one row shows.
 *
 * `compact` is one line: sender, subject, preview and date, ~31px. `comfortable`
 * is the same line with the preview given room to breathe. Compact is the
 * DEFAULT because that is what Richard asked for after seeing both; the toggle
 * exists because the right answer differs between triaging a morning's mail and
 * reading one thread, and it is two lines of state to keep.
 */
export const DENSITIES = ['compact', 'comfortable']
export const DEFAULT_DENSITY = 'compact'
export const MAIL_DENSITY_KEY = 'un1t.mail.density'

/**
 * The stored preference, or the default.
 *
 * 🔴 EVERY ACCESS IS WRAPPED. localStorage is not merely absent during SSR — it
 * THROWS on access in a private window and under a "block site data" policy, so
 * an unguarded read takes the whole surface down over a display preference.
 */
export function readDensity() {
  try {
    if (typeof window === 'undefined') return DEFAULT_DENSITY
    const stored = window.localStorage.getItem(MAIL_DENSITY_KEY)
    return DENSITIES.includes(stored) ? stored : DEFAULT_DENSITY
  } catch {
    return DEFAULT_DENSITY
  }
}

/** Persist a density. Silently ignores anything that is not one. */
export function writeDensity(density) {
  if (!DENSITIES.includes(density)) return
  try {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(MAIL_DENSITY_KEY, density)
  } catch {
    // A preference that could not be saved is a preference that resets next
    // visit. Never worth an error on screen.
  }
}
