// MAIL-ARCH.2 — the Mail surface's vocabulary, web side.
//
// The cross-platform half — ARCHIVED_STATUS, isArchived, needsReply, isUnread,
// isSpam, MAIL_VIEWS, DEFAULT_MAIL_VIEW, mailView — lives in
// shared/mail-vocabulary.js and is re-exported here through the
// @/lib/mail-vocabulary shim, so this module and mobile/lib/email-tickets.js
// read the very same functions. What is DEFINED below is the web-only remainder
// of MAIL-TRIAL.B's pure module: the list URL (a wire contract with the mail
// route), the keyboard helpers (they touch DOM tag names), and the row /
// flat-thread labels the web components render.
//
// Everything here is pure (no DOM beyond a tag name, no fetch, no clock) so the
// decisions an operator actually feels — which filter they are on, what an
// empty screen says, whether `e` archives or types the letter e — are
// unit-testable without rendering anything. Density, dock modes and the other
// persisted preferences are in ./mail-preferences.js; the reply-draft store is
// in ./reply-drafts.js; ./mail-display.js is the compatibility barrel over all
// three for one release.
export * from '@/lib/mail-vocabulary'
import { DEFAULT_MAIL_VIEW } from '@/lib/mail-vocabulary'

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

/* ── MAIL-REFINE.1 — row + flat-thread display labels ──────────────── */

/**
 * The small account tag on a row's first line (design 01): the mailbox's
 * local part plus the @ — "accounts@" — which is how an operator actually
 * distinguishes two addresses at one studio (the domain is the same on both).
 * Falls back to the label when the address has no local part to offer, and to
 * null when there is nothing honest to show: the row renders no tag for null,
 * never a placeholder.
 */
export function mailboxShortTag(mailbox) {
  const address = typeof mailbox?.address === 'string' ? mailbox.address : ''
  const at = address.indexOf('@')
  if (at > 0) return `${address.slice(0, at)}@`
  return mailbox?.label || null
}

/**
 * Which message a freshly-opened thread shows expanded (design 02): the
 * NEWEST one, i.e. the last in render order — the thread renders
 * oldest-to-newest, which is also the order the route answers in. Everything
 * before it collapses to a single line until tapped.
 */
export function defaultExpandedMessageId(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return null
  return messages[messages.length - 1]?.id ?? null
}

// A collapsed line is ONE line; anything longer than this is CSS-truncated
// anyway, so carrying more text into the DOM buys nothing.
const SNIPPET_MAX = 140

/**
 * A message's one-line stand-in while collapsed. Whitespace (including the
 * newlines every real email is full of) collapses to single spaces; empty in,
 * empty out — the component decides what an empty snippet renders as.
 */
export function messageSnippet(message) {
  const text = typeof message?.text_body === 'string' ? message.text_body : ''
  return text.replace(/\s+/g, ' ').trim().slice(0, SNIPPET_MAX)
}

/**
 * Who a collapsed line says wrote the message.
 *
 * Notes first (they are outbound rows — the same note-first ordering safety
 * property as messageKind): the author's name, because an anonymous note is a
 * note nobody can ask about. Our replies say "You". Inbound mail wears the
 * requester's NAME only when it genuinely came from the requester's address
 * (compared case-insensitively — addresses arrive from strangers' mail
 * clients); anyone else shows as the address they wrote from, because a
 * different person at the same organisation must never wear the requester's
 * name — that is EMAIL-PARTICIPANTS.8's incident in one line.
 */
export function collapsedSenderLabel(message, conversation) {
  if (message?.is_internal_note) return message.author_name || 'Staff'
  if (message?.direction === 'outbound') return 'You'
  const from = String(message?.from_email || '').trim()
  if (!from) return 'Unknown sender'
  const requester = String(conversation?.requester_email || '').trim()
  if (requester && from.toLowerCase() === requester.toLowerCase() && conversation?.requester_name) {
    return conversation.requester_name
  }
  return from
}

/**
 * MAIL-DOCK.1 — the collapsed composer's one line: "Reply to Helen…".
 *
 * FIRST name, per the approved mockup — the pill is a slim bar, and the full
 * "Reply to Helen Lawlor <helenlawlor992@gmail.com>…" treatment already lives
 * on the expanded composer's placeholder and audience sentence. Falls back to
 * the address, then to a bare "Reply…" — never "Reply to undefined".
 */
export function replyPillLabel(ticket) {
  const name = String(ticket?.requester_name || '').trim()
  const first = name.split(/\s+/)[0]
  if (first) return `Reply to ${first}…`
  const email = String(ticket?.requester_email || '').trim()
  if (email) return `Reply to ${email}…`
  return 'Reply…'
}
