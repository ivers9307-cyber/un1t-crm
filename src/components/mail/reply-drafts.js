// MAIL-ARCH.2 — the REPLY-DRAFT store, split out of mail-display.js. Pure
// apart from window.localStorage, every access of which is guarded. Consumed
// by TicketReplyBox; its mobile mirror (over AsyncStorage) is
// mobile/lib/mail-drafts.js, whose header pins the SEMANTICS below as the
// contract.

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
