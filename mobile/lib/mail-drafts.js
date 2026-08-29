// mobile/lib/mail-drafts.js — MOBILE-MAIL-THREAD.1 (mockup §04): every
// branchable decision the thread + reply screen makes, off-screen and
// vitest-tested (mobile screens have no render harness — contract rule 6).
//
// FOUR FAMILIES, one file, because they are all "what the thread screen
// decides" and C's ownership row grants exactly one lib:
//
//   1. THE REPLY-DRAFT STORE — the mobile mirror of the web store in
//      src/components/mail/mail-display.js, over AsyncStorage instead of
//      localStorage. The SEMANTICS are the contract and must not drift:
//      keyed `<prefix><userId>.<mailboxId|'none'>.<ticketId>`, fail CLOSED
//      with no user id (an unscoped draft is a draft another signed-in user
//      could hydrate — losing persistence in a broken-session edge case is
//      the cheaper failure), 14-day TTL, 30-entry eviction pruned strictly
//      inside this store's own prefix, empty text = the clear path. Only
//      { text, mode } are ever persisted — recipients and files are derived
//      per ticket from the thread itself, and persisting them would recreate
//      the cross-ticket leak the web store's header comment documents
//      (TICKET-COMPOSER-LEAK.1).
//   2. THE HYDRATION DECISION (resolveDraftHydration) — the clobber trap.
//      Hydration is async on mobile by construction (AsyncStorage + waiting
//      for the ticket row to learn mailbox_id), and web's first cut of the
//      same shape called setText('') when hydration landed and ERASED words
//      an operator had started typing. Live typing outranks the stored draft,
//      always; the rule is a pure function so the screen cannot re-derive it
//      wrong.
//   3. THREAD COLLAPSE — all but the newest two messages fold to one-line
//      rows until tapped (mockup §04 note 4: "a six-message thread opens at
//      the newest word, not a scroll marathon").
//   4. REPLY-ATTACHMENT MATHS + THE SEND GATE — the 7 MiB raw-byte ceiling
//      (a deliberate restatement of src/lib/email-outbound-attachments.js's
//      MAX_OUTBOUND_ATTACHMENT_TOTAL_BYTES: mobile cannot import src/lib,
//      and the server re-measures the true bytes either way — this figure is
//      the courtesy that turns an oversize pick into a red chip instead of a
//      failed send), the 10-file cap, and composerSendState — the ONE
//      answer to "is Send live", so the button and the submit guard cannot
//      disagree.
//
// AsyncStorage, not SecureStore: drafts are neither tokens nor customer data
// (the words a staffer typed, at most), SecureStore has a ~2 KB per-value
// ceiling a long draft would silently trip, and the web twin of this store
// lives in plain localStorage for the same reason.

import AsyncStorage from '@react-native-async-storage/async-storage'

/* ─────────────────────────── reply drafts ─────────────────────────── */

// Same prefix as the web store on purpose — one name for one concept — but
// the namespaces never meet: this one lives in a phone's AsyncStorage, that
// one in a browser's localStorage.
export const REPLY_DRAFT_PREFIX = 'un1t.email.reply-draft.'

/** The two composer modes a draft can be restored into. Anything else falls back to 'reply'. */
export const REPLY_DRAFT_MODES = ['reply', 'note']

// The store's own backstop, matching the composer's maxLength — a caller
// that skips the input cannot grow one ticket's entry without bound.
export const REPLY_DRAFT_MAX_LENGTH = 10000

// Eviction bounds, not product limits (web store's numbers, verbatim): long
// enough to survive a weekend, small enough that an abandoned draft never
// outlives its ticket. Writing re-stamps savedAt, so an active draft ages
// from its last keystroke.
export const REPLY_DRAFT_TTL_MS = 14 * 24 * 60 * 60 * 1000 // 14 days
export const REPLY_DRAFT_MAX_ENTRIES = 30

/**
 * `<prefix><userId>.<mailboxId|'none'>.<ticketId>`, or null.
 *
 * 🔴 FAIL CLOSED: no userId → NO key → no persistence at all. All three
 * segments are uuids or 'none', so the '.' separator can never be ambiguous.
 * Exported (unlike web) because the screen builds one scope object and the
 * tests pin the exact shape — the key IS the cross-user boundary.
 */
export function replyDraftKey(scope) {
  const { userId, mailboxId, ticketId } = scope || {}
  if (!userId || !ticketId) return null
  return `${REPLY_DRAFT_PREFIX}${userId}.${mailboxId || 'none'}.${ticketId}`
}

/** Every key this store owns. Its OWN prefix only — the prune below iterates
 * exactly this list, so it can never remove a stranger's key. */
async function replyDraftStorageKeys() {
  const keys = await AsyncStorage.getAllKeys()
  return (keys || []).filter(k => typeof k === 'string' && k.startsWith(REPLY_DRAFT_PREFIX))
}

/** Expired, or carrying no readable stamp at all — assume the worst, the
 * same fail-safe posture as the web store. */
function isExpiredSavedAt(savedAt, now) {
  return typeof savedAt !== 'number' || (now - savedAt > REPLY_DRAFT_TTL_MS)
}

/**
 * TTL sweep, then count eviction (oldest first), after every successful
 * write. Its own try/catch: a prune that could not finish must never turn a
 * successful draft write into an error, and must never remove the entry that
 * was just written on partial information.
 */
async function pruneReplyDrafts(now) {
  try {
    const keys = await replyDraftStorageKeys()
    const pairs = await AsyncStorage.multiGet(keys)
    const survivors = []
    const dead = []
    for (const [key, raw] of pairs || []) {
      let savedAt = null
      try {
        const parsed = JSON.parse(raw)
        savedAt = typeof parsed?.savedAt === 'number' ? parsed.savedAt : null
      } catch {
        savedAt = null
      }
      if (isExpiredSavedAt(savedAt, now)) dead.push(key)
      else survivors.push({ key, savedAt })
    }
    if (survivors.length > REPLY_DRAFT_MAX_ENTRIES) {
      survivors.sort((a, b) => a.savedAt - b.savedAt)
      const excess = survivors.length - REPLY_DRAFT_MAX_ENTRIES
      for (let i = 0; i < excess; i++) dead.push(survivors[i].key)
    }
    if (dead.length) await AsyncStorage.multiRemove(dead)
  } catch {
    // Leaves the store exactly as it was before this write — no worse than
    // before eviction existed.
  }
}

/**
 * The saved draft, or null. No draft, corrupt storage, an expired entry, an
 * unavailable AsyncStorage and a keyless scope all collapse to the same
 * "start blank" answer — none is a distinction the composer can act on.
 *
 * `now` is injectable for the TTL tests only; callers pass nothing.
 */
export async function readReplyDraft(scope, now = Date.now()) {
  try {
    const key = replyDraftKey(scope)
    if (!key) return null
    const raw = await AsyncStorage.getItem(key)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed.text !== 'string' || !parsed.text.trim()) return null
    if (isExpiredSavedAt(parsed.savedAt, now)) {
      // Dead weight the next prune would remove anyway — cleared here so a
      // read-only caller never waits for a write to reclaim it.
      await clearReplyDraft(scope)
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
 * Save a draft. Answers true only when the entry actually landed — the
 * screen's "Draft saved" caption reads this, so it is stated, not hoped.
 *
 * 🔴 EMPTY TEXT IS THE CLEAR PATH, not a one-character draft: a composer the
 * operator emptied has nothing worth restoring, and a blank entry per ticket
 * ever typed into is exactly the unbounded growth the eviction exists to
 * avoid.
 */
export async function writeReplyDraft(scope, draft, now = Date.now()) {
  const key = replyDraftKey(scope)
  if (!key) return false
  const text = typeof draft?.text === 'string' ? draft.text : ''
  if (!text.trim()) {
    await clearReplyDraft(scope)
    return false
  }
  const mode = REPLY_DRAFT_MODES.includes(draft?.mode) ? draft.mode : 'reply'
  try {
    await AsyncStorage.setItem(
      key,
      JSON.stringify({ text: text.slice(0, REPLY_DRAFT_MAX_LENGTH), mode, savedAt: now })
    )
    // Every successful write is the eviction checkpoint.
    await pruneReplyDrafts(now)
    return true
  } catch {
    // A draft that could not be saved survives only as long as the screen —
    // never worth an error over.
    return false
  }
}

/** Remove one scope's draft outright (the send succeeded; nothing left to restore). */
export async function clearReplyDraft(scope) {
  const key = replyDraftKey(scope)
  if (!key) return
  try {
    await AsyncStorage.removeItem(key)
  } catch {
    // Same posture as the read/write paths.
  }
}

/**
 * Remove EVERY user's drafts on this device. Deliberately unwired (the web
 * store's MAIL-DRAFTSCOPE.2 reasoning holds here too: per-user keys removed
 * the reason for a sign-out wipe) — kept for a future explicit "clear drafts"
 * affordance and for support use. Safe to call unconditionally.
 */
export async function clearAllReplyDrafts() {
  try {
    const keys = await replyDraftStorageKeys()
    if (keys.length) await AsyncStorage.multiRemove(keys)
    return keys.length
  } catch {
    return 0
  }
}

/**
 * What to do when the async draft read finally lands.
 *
 * 🔴 LIVE TYPING OUTRANKS THE STORED DRAFT. On mobile hydration waits on
 * AsyncStorage AND on the ticket row (the mailbox key segment rides on it),
 * so an operator can be mid-sentence before the read resolves. Web's first
 * cut of exactly this shape set the composer to the stored draft regardless
 * and erased their words (TicketReplyBox.jsx's hydration comment); the rule
 * is a pure function here so the screen applies it rather than re-deriving
 * it.
 *
 *   keep-live — something is typed: keep it, and persist IT now that the
 *               scope exists (the caller writes the live text through).
 *   hydrate   — nothing typed, a draft exists: restore { text, mode }.
 *   none      — nothing anywhere: start blank, and arm nothing.
 */
export function resolveDraftHydration({ liveText, draft } = {}) {
  const live = typeof liveText === 'string' ? liveText : ''
  if (live.trim()) return { action: 'keep-live' }
  if (draft && typeof draft.text === 'string' && draft.text.trim()) {
    return {
      action: 'hydrate',
      text: draft.text,
      mode: REPLY_DRAFT_MODES.includes(draft.mode) ? draft.mode : 'reply',
    }
  }
  return { action: 'none' }
}

/* ─────────────────────────── thread collapse ─────────────────────────── */

// How many of the newest messages open expanded. Two, per the approved
// mockup: the newest word plus the exchange it answers.
export const THREAD_TAIL_EXPANDED = 2

/**
 * The thread, annotated with whether each message renders as a one-line
 * collapsed row. Everything older than the newest THREAD_TAIL_EXPANDED
 * collapses unless the operator has tapped it open (`expandedIds`).
 *
 * Messages arrive oldest-first from getTicket — this trusts the order rather
 * than re-sorting, because re-sorting here and not on screen would make the
 * plan disagree with what is painted.
 */
export function threadDisplayPlan(messages, expandedIds = new Set()) {
  const list = Array.isArray(messages) ? messages : []
  const firstExpanded = Math.max(0, list.length - THREAD_TAIL_EXPANDED)
  return list.map((message, i) => ({
    message,
    collapsed: i < firstExpanded && !expandedIds.has(message?.id),
  }))
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** '09:05' today, '25 Aug' otherwise, '' for garbage — never "Invalid Date".
 * Local Date methods only; no ISO-string round trip (CLAUDE.md timezones). */
function collapsedWhen(iso, now) {
  const d = new Date(iso || '')
  if (Number.isNaN(d.getTime())) return ''
  const sameDay = d.getFullYear() === now.getFullYear()
    && d.getMonth() === now.getMonth()
    && d.getDate() === now.getDate()
  if (sameDay) {
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`
}

/**
 * The one line a collapsed message shows: who, what happened, when.
 *
 * THE NOTE TONE SURVIVES COLLAPSE. is_internal_note is tested FIRST, same as
 * ticketMessageKind — a staff-only note folded into a row that reads like
 * correspondence is the one mistake this surface must never make, expanded
 * or not (the screen tints tone 'note' rows amber).
 *
 * @param {object|null} message
 * @param {{ isFirst?: boolean, fallbackName?: string, now?: Date }} [opts]
 *   `fallbackName` is the requester's display name for inbound rows;
 *   `now`/`isFirst` come from the caller because a message row knows neither.
 * @returns {{ who: string, what: string, when: string, tone: 'note'|'out'|'in' }}
 */
export function collapsedRowMeta(message, { isFirst = false, fallbackName = '', now = new Date() } = {}) {
  const m = message || {}
  const when = collapsedWhen(m.sent_at || m.created_at, now)
  if (m.is_internal_note) {
    return { who: m.author_name || 'Staff', what: 'Internal note', when, tone: 'note' }
  }
  if (m.direction === 'outbound') {
    return { who: m.author_name || 'You', what: 'Replied', when, tone: 'out' }
  }
  return {
    who: fallbackName || m.from_email || 'Member',
    what: isFirst ? 'First message' : 'Wrote',
    when,
    tone: 'in',
  }
}

/* ──────────────── reply attachments + the send gate ──────────────── */

// Deliberate restatements of ./email-api.js's MAX_OUTBOUND_ATTACHMENT_TOTAL_BYTES
// / MAX_OUTBOUND_ATTACHMENTS (themselves mirrors of
// src/lib/email-outbound-attachments.js, which mobile cannot import). NOT
// imported from email-api: that module pulls './supabase' — the RN runtime,
// which must never load under vitest — into every consumer of this pure lib.
// The test file pins the two pairs equal instead, so they cannot drift.
// 7 MiB of RAW bytes ≈ 9.79 MB after base64, inside Postmark's 10 MB message
// ceiling with generous headroom; the server re-measures the true downloaded
// bytes at send time either way, so these figures are the courtesy that turns
// a refusal into a red chip BEFORE the operator types a reply — never the
// gate itself.
export const MAX_REPLY_ATTACHMENTS = 10
export const MAX_REPLY_ATTACHMENT_TOTAL_BYTES = 7 * 1024 * 1024

/** How much of the byte budget the chosen files spend. Unreadable sizes
 * count as 0 here (display maths); admitPickedFile refuses them at the door. */
export function attachmentBudget(files) {
  const used = (Array.isArray(files) ? files : [])
    .reduce((sum, f) => sum + (Number.isFinite(Number(f?.size)) ? Number(f.size) : 0), 0)
  return {
    used,
    limit: MAX_REPLY_ATTACHMENT_TOTAL_BYTES,
    over: used > MAX_REPLY_ATTACHMENT_TOTAL_BYTES,
  }
}

/** Is anything still moving? Send is blocked on this — a reply must never
 * quietly go with a subset of the chips on screen. */
export function hasPendingUploads(files) {
  return (Array.isArray(files) ? files : []).some(f => f?.status === 'uploading')
}

/**
 * The draft refs the reply's `attachments` field carries — ready files only.
 * A file still uploading or failed contributes NOTHING; uploading also
 * blocks the send (composerSendState), and a failed chip says in red that it
 * will not be sent, so this can never smuggle a subset silently.
 */
export function readyAttachmentRefs(files) {
  return (Array.isArray(files) ? files : [])
    .filter(f => f?.status === 'ready' && f.ref)
    .map(f => f.ref)
}

/**
 * May this picked file join the strip? Null = yes; otherwise the sentence
 * the operator reads. Checked BEFORE any upload starts — kinder, not the
 * gate (the send route re-measures; see the constants' comment).
 */
export function admitPickedFile(files, { name, size } = {}) {
  const list = Array.isArray(files) ? files : []
  if (list.length >= MAX_REPLY_ATTACHMENTS) {
    return `You can attach up to ${MAX_REPLY_ATTACHMENTS} files to one email.`
  }
  const n = Number(size)
  if (!Number.isFinite(n) || n < 0) {
    // An unreadable size cannot be budgeted, so it is refused rather than
    // admitted blind and discovered at send time — same fail direction as
    // the web module's exceedsOutboundTotal.
    return `${name || 'That file'} has no readable size, so it can’t be attached here.`
  }
  if (attachmentBudget(list).used + n > MAX_REPLY_ATTACHMENT_TOTAL_BYTES) {
    return `${name || 'That file'} would push this reply over 7 MB of attachments — send it in its own email instead.`
  }
  return null
}

/**
 * THE send gate — one derivation for the button's disabled state and the
 * submit guard, so they cannot disagree (the web composer states its rules
 * twice for exactly that reason; here they are stated once and read twice).
 *
 * Reason order is most-specific-first and load-bearing: a note with files is
 * told about the files, not about an audience it does not have.
 */
export function composerSendState({ text, isNote = false, files = [], audienceDisabled = false, sending = false } = {}) {
  if (!String(text || '').trim()) return { canSend: false, reason: 'empty' }
  if (sending) return { canSend: false, reason: 'sending' }
  if (isNote) {
    // A note is sent to NOBODY: files cannot ride on it (the route refuses
    // the combination too), and the reply audience is irrelevant to it.
    if ((Array.isArray(files) ? files : []).length > 0) {
      return { canSend: false, reason: 'note_has_files' }
    }
    return { canSend: true, reason: null }
  }
  if (audienceDisabled) return { canSend: false, reason: 'no_audience' }
  if (hasPendingUploads(files)) return { canSend: false, reason: 'uploading' }
  if (attachmentBudget(files).over) return { canSend: false, reason: 'over_budget' }
  return { canSend: true, reason: null }
}
