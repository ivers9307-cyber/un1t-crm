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
// MAIL-REFINE.1 — the approved subject-first two-line row is the
// 'comfortable' layout, and it is what Richard approved as THE row, so it is
// the default; 'compact' survives as the one-line toggle for dense triage.
export const DEFAULT_DENSITY = 'comfortable'
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

/* ── MAIL-REFINE.1 — row + flat-thread display helpers ─────────────── */

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

/* ─────────────────────────── reply drafts ─────────────────────────── */

/**
 * TicketReplyBox holds its text in plain useState, and TicketThread
 * deliberately REMOUNTS it on every ticket switch (`key={ticketId}`) — that
 * remount is TICKET-COMPOSER-LEAK.1's guard against member A's half-written
 * reply going out addressed to member B. Losing the words on every switch,
 * every `e` (archive auto-advances the selection), every refresh and every
 * crash was the cost of that guard, paid by the operator instead.
 *
 * These functions pay it back WITHOUT touching the guard: the draft is
 * looked up by ticket id, so the remount that protects against the leak is
 * also exactly what makes "restore the right draft for the right ticket"
 * free — there is no cross-ticket state to leak because there is no
 * cross-ticket key. A single shared key (or a key that fell back to
 * something other than the ticket id) would reopen the same leak this store
 * exists downstream of, by a different door.
 *
 * 🔴 WHAT IS PERSISTED, AND WHAT NEVER IS. A draft is `{ text, mode, savedAt }`
 * — the words an operator actually typed, which of the two composer modes
 * they were in, and when. Recipients, Cc/Bcc, removed participants and
 * attached files are NEVER part of it: those are derived per ticket from the
 * thread itself (see TicketReplyBox's own header comment on `lockedTo`),
 * which is precisely the surface TICKET-COMPOSER-LEAK.1 guards. Persisting
 * them here would recreate the leak the remount was built to close — a
 * restored draft naming yesterday's recipients on today's ticket.
 *
 * 🔴 CROSS-TICKET IS IMPOSSIBLE; CROSS-LOCATION IS IMPOSSIBLE TOO, FOR THE
 * SAME REASON; CROSS-USER ON A SHARED BROWSER IS REAL, AND STATED HONESTLY
 * RATHER THAN LEFT IMPLIED. Ticket ids are globally unique across every
 * location this CRM serves, so there is no location dimension to this key at
 * all — the per-ticket key already closes both doors structurally, the same
 * way it closes the cross-ticket one. What it does NOT close is per-BROWSER
 * vs per-OPERATOR: this store lives in one origin's localStorage, which is
 * shared by whoever is sitting at the machine, not by whoever is logged in.
 * On a shared front-desk machine, staff-A's half-written reply hydrates into
 * staff-B's composer under B's identity the moment B opens the same ticket —
 * one Send from a mis-send. That exposure is bounded (only tickets whose
 * mailbox both staff can see; drafts expire; see the TTL/count eviction
 * below), but it is real, and the orchestrator is flagging the shared-machine
 * judgment call to Richard rather than this file quietly deciding it away.
 * `clearAllReplyDrafts()` below exists for exactly this: a sign-out is the
 * one moment a browser can be trusted to no longer belong to the departing
 * operator, so it is the natural place to wipe every draft — wiring it there
 * is NOT this file's job (the sign-out site is owned elsewhere).
 *
 * 🔴 EVICTION. Per-entry length is capped (REPLY_DRAFT_MAX_LENGTH), but
 * nothing capped the NUMBER of entries until now — an abandoned draft used to
 * live forever, and once the origin's 5MB quota eventually filled, `setItem`
 * would throw ORIGIN-WIDE: silently breaking every other localStorage
 * consumer on this origin (studio device pairing, sidebar state, the command
 * palette), not just drafts. Every write now stamps `savedAt` and prunes,
 * scoped STRICTLY to this store's own prefix — a prune must never remove a
 * key it does not own. TTL first (14 days — long enough to survive a
 * weekend, short enough that an abandoned draft does not outlive its ticket),
 * then a max-entry count (30) evicting the oldest survivors by `savedAt`.
 * `readReplyDraft` treats an entry the TTL would evict as absent, and clears
 * it on the way out rather than leaving a dead key for the next prune to find.
 */
export const REPLY_DRAFT_PREFIX = 'un1t.email.reply-draft.'

/** The two composer modes a draft can be restored into. Anything else falls back to 'reply'. */
export const REPLY_DRAFT_MODES = ['reply', 'note']

// A cap, not a promise the composer itself already enforces (its <textarea>
// has its own maxLength) — this is the store's OWN backstop, so a caller
// that skips the textarea (a paste event, a future composer that forgets the
// prop) still cannot grow one ticket's localStorage entry without bound.
export const REPLY_DRAFT_MAX_LENGTH = 10000

// How long an unattended draft is worth keeping, and how many can exist at
// once. Both are eviction bounds, not product limits: an operator who is
// actively working a ticket never notices either — writing keeps re-stamping
// `savedAt`, and 30 concurrent drafts is far more than one desk juggles.
export const REPLY_DRAFT_TTL_MS = 14 * 24 * 60 * 60 * 1000 // 14 days
export const REPLY_DRAFT_MAX_ENTRIES = 30

/**
 * MAIL-DRAFTSCOPE.1 — the key is `<prefix><userId>.<mailboxId|none>.<ticketId>`.
 *
 * 🔴 PER USER AND PER EMAIL ACCOUNT, BY RICHARD'S CALL (2026-08-29). The
 * original per-ticket key made cross-TICKET and cross-LOCATION leakage
 * structurally impossible (ticket ids are globally-unique uuids) but was
 * per-BROWSER: on a shared front-desk machine, staff-A's half-written reply
 * hydrated into staff-B's composer under B's identity. Scoping the key by the
 * signed-in user makes that impossible too — and it is what lets drafts
 * SURVIVE sign-out (the previous wipe-on-sign-out existed only because the
 * next person could inherit them; per-user keys remove the reason, so a
 * returning operator finds their draft where they left it, bounded by the TTL).
 *
 * The mailbox segment scopes drafts to the email ACCOUNT the conversation
 * belongs to; an orphan ticket (mailbox deleted → NULL) uses the 'none'
 * sentinel so it still persists, per-user. All three segments are uuids or
 * 'none', so the '.' separator can never be ambiguous.
 *
 * 🔴 FAIL CLOSED: no userId → NO key → no persistence. An unscoped draft is a
 * draft some other signed-in user could hydrate; losing persistence in a
 * broken-session edge case is the cheaper failure by far.
 */
function replyDraftKey(scope) {
  const { userId, mailboxId, ticketId } = scope || {}
  if (!userId || !ticketId) return null
  return `${REPLY_DRAFT_PREFIX}${userId}.${mailboxId || 'none'}.${ticketId}`
}

/** Every key this store owns, in whatever order localStorage happens to hold them. */
function replyDraftStorageKeys() {
  const keys = []
  for (let i = 0; i < window.localStorage.length; i++) {
    const key = window.localStorage.key(i)
    if (key && key.startsWith(REPLY_DRAFT_PREFIX)) keys.push(key)
  }
  return keys
}

/** A draft older than the TTL, or one with no readable `savedAt` at all — the
 * same fail-safe posture as everywhere else in this store: an unreadable
 * timestamp is treated as "assume the worst", not "assume it is fine". */
function isExpiredSavedAt(savedAt) {
  return typeof savedAt !== 'number' || (Date.now() - savedAt > REPLY_DRAFT_TTL_MS)
}

/**
 * Called at the end of every successful write. Removes anything past the TTL,
 * then — if the survivors still outnumber REPLY_DRAFT_MAX_ENTRIES — removes
 * the oldest of what is left until the count fits.
 *
 * 🔴 ONLY EVER TOUCHES THIS STORE'S OWN PREFIX. `replyDraftStorageKeys()` is
 * the sole source of what gets iterated, so a sibling consumer's key (device
 * pairing, sidebar state, the command palette) can never be read, let alone
 * removed by this pass — the failure mode this exists to prevent (an
 * origin-wide quota error) would otherwise become a second one (this store
 * deleting a stranger's data to make room for its own).
 *
 * Deliberately its own try/catch: a prune that could not finish must not
 * turn a successful draft write into a thrown error the operator sees.
 */
function pruneReplyDrafts() {
  try {
    const entries = replyDraftStorageKeys().map(key => {
      let savedAt = null
      try {
        const parsed = JSON.parse(window.localStorage.getItem(key))
        savedAt = typeof parsed?.savedAt === 'number' ? parsed.savedAt : null
      } catch {
        savedAt = null
      }
      return { key, savedAt }
    })

    const survivors = []
    for (const entry of entries) {
      if (isExpiredSavedAt(entry.savedAt)) {
        window.localStorage.removeItem(entry.key)
      } else {
        survivors.push(entry)
      }
    }

    if (survivors.length > REPLY_DRAFT_MAX_ENTRIES) {
      survivors.sort((a, b) => a.savedAt - b.savedAt)
      const excess = survivors.length - REPLY_DRAFT_MAX_ENTRIES
      for (let i = 0; i < excess; i++) {
        window.localStorage.removeItem(survivors[i].key)
      }
    }
  } catch {
    // A prune that could not run leaves the store exactly as it was before
    // this write — no worse than before eviction existed at all.
  }
}

/**
 * The saved draft for this ticket, or null — no draft, corrupt storage, an
 * expired entry, an unavailable localStorage, or a falsy ticket id all
 * collapse to the same "start blank" answer, because none of them is a
 * distinction the composer can act on differently.
 */
export function readReplyDraft(scope) {
  try {
    if (typeof window === 'undefined') return null
    const key = replyDraftKey(scope)
    if (!key) return null
    const raw = window.localStorage.getItem(key)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed.text !== 'string' || !parsed.text.trim()) return null
    if (isExpiredSavedAt(parsed.savedAt)) {
      // Dead weight the next prune would remove anyway — cleared here too so
      // a read-only caller never has to wait for a write to reclaim it.
      clearReplyDraft(scope)
      return null
    }
    return {
      text: parsed.text,
      mode: REPLY_DRAFT_MODES.includes(parsed.mode) ? parsed.mode : 'reply',
    }
  } catch {
    return null
  }
}

/**
 * Save a draft for this ticket.
 *
 * 🔴 EMPTY TEXT IS THE CLEAR PATH, NOT A ONE-CHARACTER DRAFT. A composer
 * whose operator cleared their own text (or never wrote anything) has
 * nothing worth restoring, and storing a blank entry per ticket ever typed
 * into is exactly the unbounded growth this function exists to avoid — so
 * whitespace-only text takes the same branch as none at all.
 */
export function writeReplyDraft(scope, draft) {
  const key = replyDraftKey(scope)
  if (!key) return
  const text = typeof draft?.text === 'string' ? draft.text : ''
  if (!text.trim()) {
    clearReplyDraft(scope)
    return
  }
  const mode = REPLY_DRAFT_MODES.includes(draft?.mode) ? draft.mode : 'reply'
  try {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(
      key,
      JSON.stringify({ text: text.slice(0, REPLY_DRAFT_MAX_LENGTH), mode, savedAt: Date.now() })
    )
    // Every successful write is the eviction checkpoint — see pruneReplyDrafts.
    pruneReplyDrafts()
  } catch {
    // A draft that could not be saved is a draft that only survives until
    // the tab closes. Never worth an error on screen over.
  }
}

/** Remove a ticket's saved draft outright (send succeeded; there is nothing left to restore). */
export function clearReplyDraft(scope) {
  const key = replyDraftKey(scope)
  if (!key) return
  try {
    if (typeof window === 'undefined') return
    window.localStorage.removeItem(key)
  } catch {
    // Same posture as the read/write paths above.
  }
}

/**
 * Remove EVERY user's reply drafts on this device.
 *
 * MAIL-DRAFTSCOPE.2 — deliberately UNWIRED since drafts became per-user: the
 * sign-out wipe existed only because per-ticket keys let the next login
 * inherit them, and per-user keys remove the reason (a returning operator now
 * finds their draft where they left it, bounded by the TTL). Kept exported
 * for a future explicit "clear drafts on this device" affordance and for
 * support use; safe to call unconditionally — every access is try/caught and
 * a hostile localStorage cannot make it throw.
 */
export function clearAllReplyDrafts() {
  let cleared = 0
  try {
    if (typeof window === 'undefined') return 0
    for (const key of replyDraftStorageKeys()) {
      window.localStorage.removeItem(key)
      cleared += 1
    }
  } catch {
    // A clear that could not finish still cleared what it cleared — a
    // sign-out must never hang or error over a leftover draft.
  }
  return cleared
}
