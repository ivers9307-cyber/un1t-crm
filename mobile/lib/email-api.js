// Mail API helpers for mobile (MOBILE-MAIL.1; was the ticket-queue client,
// EMAIL-TICKET-M.1).
//
// The CRM's email surface is Mail (/communications/mail on web —
// RETIRE-TICKETS.1 retired the ticket queue and mig 578 the surface split).
// The LIST and the two verbs (archive, read state) ride /api/email/mail*;
// the thread, reply and attachments stay on the shared /api/email/tickets/[id]
// detail routes, which are NOT deprecated — only the old list/count/assign/
// status routes are, kept alive solely for bundles older than this one.
//
// Same posture as before: the email_* tables carry a RESTRICTIVE deny-all
// policy for authenticated/anon, so mobile never reads them direct. Every call
// rides /api/* via the api() helper, which carries the Bearer token +
// x-active-location + x-impersonate-target headers. Those routes are
// service-role (no RLS), and they gate on the top-level `email_inbox`
// permission plus a per-account email_mailbox_access grant — the SAME two
// levels the web surface is behind. Screens must gate on `email_inbox` too
// (canMobile routes it through CROSS_PLATFORM_KEYS to the top-level key), or
// the UI offers something every call refuses.
//
// EMAIL-TICKET-CLEANUP.1 — that permission now resolves AT the location the
// call is about (the ticket's own, or the one the list route was handed) rather
// than the caller's active one, which matters more on mobile than on web: the
// app carries x-active-location per request, so a staffer switching studios
// used to change what they could read at BOTH. The list route still answers 403
// when the key is missing; the per-ticket routes answer 404, since there the
// refusal has to be indistinguishable from "no such ticket".
//
// TWO DIFFERENCES FROM THE OLD CONVERSATIONS API, both deliberate:
//   • the list route returns { mailboxes, tickets }, NOT a flat list — the
//     mailboxes are the access model made visible and are what lets a row say
//     which account it arrived at.
//   • reading a conversation does not clear its unread state as a side
//     effect; setConversationSeen() is its own call, so a GET stays a GET.

import { api } from './api'
import { supabase } from './supabase'
import { readFileAsArrayBuffer } from './upload-bytes'
import { ticketsToInboxRows } from './email-tickets'

// Re-exported so screens that already import their display helper from here
// keep one import for "the email surface". requesterLabel is the ticket-era
// precedence: requester_name → requester_email.
export { requesterLabel as emailDisplayName } from './email-tickets'

// The three views the mail route whitelists. Anything else is a 400, and
// omitting the param entirely is the inbox (live conversations). The screen's
// chips map their id onto these via ticketViewWire() in ./email-tickets.
export const MAIL_VIEWS = Object.freeze(['inbox', 'needs_reply', 'archived'])

/**
 * The studio's mail, shaped into rows for the Mail tab's list.
 *
 * A caller with no visible mailboxes gets an empty list, not an error — a
 * studio that does not do email and a coach with no account grants are both
 * normal states.
 *
 * MOBILE-MAIL-A.1 grew the three list refinements the redesign needs, all
 * pass-throughs to params the route already whitelists:
 *   • `q`         — websearch text; the route searches across ALL views (its
 *                   deliberate q-overrides-view rule) and sets search_partial
 *                   when it stopped at the most recent matches.
 *   • `before`    — keyset cursor on last_message_at, INCLUSIVE: the boundary
 *                   row comes back again on the next page, on purpose (a
 *                   timestamp is not unique). CALLERS MUST DEDUPE appended
 *                   pages by row id, or every page seam shows one row twice.
 *   • `mailboxId` — one account's tab. An id outside the caller's visible set
 *                   answers EMPTY, not an error (the route refuses to leak
 *                   which addresses a studio runs), so a stale chip reads as
 *                   an empty inbox rather than a crash.
 *
 * @param {string} locationId  required by the route (400 without it)
 * @param {object} [opts]
 * @param {'inbox'|'needs_reply'|'archived'} [opts.view]
 * @param {string} [opts.q]         search text (omit/empty = no search)
 * @param {string} [opts.before]    next_before from the previous page
 * @param {string} [opts.mailboxId] restrict to one visible account
 * @returns {Promise<{success: boolean, data?: object[], mailboxes?: object[],
 *                    needsReplyCount?: number, nextBefore?: string|null,
 *                    searchPartial?: boolean, error?: string}>}
 *   nextBefore is null on the last page; feed it back as `before` otherwise.
 */
export async function listMail(locationId, { view, q, before, mailboxId } = {}) {
  if (!locationId) return { success: false, error: 'No active location' }
  const params = new URLSearchParams({ location_id: locationId })
  if (view) params.set('view', view)
  if (mailboxId) params.set('mailbox_id', mailboxId)
  if (q) params.set('q', q)
  if (before) params.set('before', before)

  const res = await api(`/api/email/mail?${params.toString()}`, { locationId })
  // `status` rides along on failure so the contact composer can tell a 403
  // (no Mail access at this studio — a state) from a fault — MAIL-403.1.
  if (!res.success) return { success: false, status: res.status, error: res.error || 'Failed to load email' }

  const mailboxes = res.data?.mailboxes || []
  return {
    success: true,
    data: ticketsToInboxRows({ tickets: res.data?.conversations || [], mailboxes }),
    mailboxes,
    needsReplyCount: res.data?.needs_reply_count ?? 0,
    nextBefore: res.data?.next_before ?? null,
    searchPartial: !!res.data?.search_partial,
    // 🔴 Neither count flag may be dropped: the route's own comment says
    // neither is allowed to render as "all read". `countsUnavailable` means
    // the per-message scan FAILED (every row then claims unread:false);
    // `countsPartial` means the page outgrew one scan. Screens must render
    // a notice rather than a fully-triaged-looking inbox.
    countsUnavailable: !!res.data?.counts_unavailable,
    countsPartial: !!res.data?.counts_partial,
  }
}

/**
 * Every readable studio's Mail in one answer — the endpoint behind the
 * location tiles and All mode (MAIL-ALLLOC.1; GET /api/email/mail/digest).
 *
 * A PASSTHROUGH ON PURPOSE. The route already returns locations name-sorted
 * with rows stamped exactly like list rows (needs_reply, archived, unread,
 * unread_count_messages, has_attachments), locations the caller can't read
 * or that have no visible mailboxes absent, and a location that FAILED
 * reported as `unavailable: true` rather than dropped. mail-digest.js owns
 * every rendering decision over this shape; re-deriving any of it here is a
 * second answer that drifts.
 *
 * Deliberately NO location header: eligibility is resolved per location
 * server-side (the same email_inbox key each scoped route gates on), and the
 * answer is the whole estate whatever studio the session is parked at.
 *
 * 🔴 `needsReplyTotal` null means the digest was PARTIAL — the summed badge
 * keeps its LAST GOOD number off exactly that distinction, so null must
 * never collapse to 0 here. A failure (or a success with no body) answers
 * `{ success: false }` and the poller keeps its last state.
 *
 * @param {'inbox'|'needs_reply'|'archived'|null} [view] null/omitted = inbox
 *   (send no param), mirroring listMail's absent-view rule.
 */
export async function fetchMailDigest(view) {
  const res = await api(`/api/email/mail/digest${view ? `?view=${encodeURIComponent(view)}` : ''}`)
  if (!res.success || !res.data) {
    return { success: false, error: res.error || 'Failed to load your mail' }
  }
  return {
    success: true,
    locations: res.data.locations || [],
    needsReplyTotal: res.data.needs_reply_total ?? null,
    partial: !!res.data.partial,
  }
}

/**
 * Archive (or bring back) one conversation. Archive IS status='closed'
 * wearing a different word — one lifecycle, two vocabularies.
 *
 * For an IMAP-connected account the server also MOVEs the real messages to
 * the provider's Archive folder; the response's `writeback` notice says when
 * that half could not land. For Postmark accounts and orphans that half is a
 * silent no-op — there is no mailbox to change.
 */
export function archiveConversation(ticketId, archived, locationId) {
  return api(`/api/email/mail/${ticketId}/archive`, {
    method: 'POST',
    body: { archived: !!archived },
    locationId,
  })
}

/**
 * Read state, both directions. seen=true stamps every unread inbound message
 * (fire on open — replaces the ticket-era /read call, and unlike it also
 * mirrors \Seen into a connected real mailbox); seen=false is Mark as
 * unread, the mail-app gesture for "deal with this later".
 */
export function setConversationSeen(ticketId, seen, locationId) {
  return api(`/api/email/mail/${ticketId}/seen`, {
    method: 'POST',
    body: { seen: !!seen },
    locationId,
  })
}

/**
 * One ticket and its thread, oldest message first.
 *
 * Does NOT clear the unread state — call setConversationSeen() for that.
 * 404s (not 403s) for a ticket the caller may not see, so an id can't be
 * probed; surface it as a plain "not found" rather than a permission story.
 */
export async function getTicket(ticketId, locationId) {
  const res = await api(`/api/email/tickets/${ticketId}`, { locationId })
  if (!res.success) return { success: false, error: res.error || 'Failed to load ticket' }
  return {
    success: true,
    ticket: res.data?.ticket || null,
    messages: res.data?.messages || [],
    // The route sets this when the ATTACHMENT LOOKUP failed — the messages are
    // real but their files are unknown. Dropping it renders a thread with no
    // attachment chips and no warning, which reads as "the member sent no
    // files": the silent wrong answer the route exists to prevent.
    attachmentsUnavailable: !!res.data?.attachments_unavailable,
    // MAIL-REFINE.2 — provenance for the Merged-in dividers; [] when none.
    mergedSources: res.data?.merged_sources || [],
    // EMAIL-PARTICIPANTS.9 — { to, mode, over_cap, empty } | null, derived from
    // the WHOLE thread server-side. This used to be dropped here, so the
    // composer footer fell back to a hard-coded "Sends an email to
    // <requester>" even though a reply from this screen has always gone to
    // everyone the server derives (replyToTicket below posts { text, internal }
    // only — the route adds the rest). That understated the true audience on
    // every multi-party thread (2026-08-09 audit). null means the route could
    // not derive one (an own-address lookup blip); ticketReplyAudienceMeta()
    // in email-tickets.js falls back to the requester address for that case,
    // same as TicketReplyBox.jsx does on web.
    reply_recipients: res.data?.reply_recipients || null,
  }
}

/**
 * Answer the member, or add a staff-only note.
 *
 * `internal: true` writes to the thread and SENDS NOTHING — the member never
 * sees it, and the ticket does not move to pending. Callers must make which
 * one happened unmistakable in the UI before this is invoked.
 *
 * A real reply rides Postmark's transactional stream with threading headers
 * and the sender's signature, all server-side.
 *
 * MOBILE-MAIL-A.1 — `attachments` carries draft refs from the two helpers
 * below (sign → upload → the ref), the same body field the route's
 * ReplySchema names. Omitted entirely when there are none, so a plain reply's
 * wire shape stays byte-identical to every reply this app has ever sent.
 * NEVER sent on an internal note: the route sends nothing for a note, and a
 * body claiming files rode a message that never left would be refused — or
 * worse, silently ignored — either way a chip lying about what the member got.
 */
export function replyToTicket(ticketId, text, { internal = false, locationId, attachments } = {}) {
  const body = { text, internal: !!internal }
  if (!internal && Array.isArray(attachments) && attachments.length > 0) {
    body.attachments = attachments
  }
  return api(`/api/email/tickets/${ticketId}/reply`, {
    method: 'POST',
    locationId,
    body,
  })
}

/**
 * Start a conversation — a new email FROM one of the studio's mailboxes
 * (MOBILE-MAIL-A.1; POST /api/email/tickets/compose).
 *
 * THE ENVELOPE PASSES THROUGH UNTOUCHED, refusals included. The route owns
 * every rule — the 25-recipient cap + dedupe, the mailbox gate (a mailbox the
 * caller may not send as is a 404, indistinguishable from "no such mailbox"),
 * the attachment ceiling re-measured on real bytes — and its error strings
 * are operator-facing sentences that name the limit. Re-implementing any of
 * them here would be a second answer that drifts; re-wording them would hide
 * the number the operator needs.
 *
 * The send happens FIRST server-side: a failed send writes nothing, so
 * success:false with no `data.sent` marker always means "safe to retry".
 * (The route's rare sent-but-unfiled branch answers success:false WITH
 * `data.sent: true` — surface that one as "do not resend", exactly as its
 * error text says.)
 *
 * @param {object} args
 * @param {string}   args.mailboxId  the From account (must be in the caller's
 *   visible set — listMail's `mailboxes` is where pickers get it)
 * @param {string[]} args.to         at least one address
 * @param {string[]} [args.cc]
 * @param {string[]} [args.bcc]
 * @param {string}   args.subject
 * @param {string}   args.text
 * @param {Array}    [args.attachments] draft refs from the helpers below
 * @param {string}   [args.locationId]
 */
export function composeEmail({
  mailboxId, to, cc, bcc, subject, text, attachments, locationId,
} = {}) {
  const body = { mailbox_id: mailboxId, to, subject, text }
  // Empty lists stay off the wire — the route defaults them, and the smallest
  // body is the one oldest-bundle-compatible shape nothing can misread.
  if (Array.isArray(cc) && cc.length > 0) body.cc = cc
  if (Array.isArray(bcc) && bcc.length > 0) body.bcc = bcc
  if (Array.isArray(attachments) && attachments.length > 0) body.attachments = attachments
  return api('/api/email/tickets/compose', { method: 'POST', body, locationId })
}

/**
 * Pass one message on the ticket to somebody else (MOBILE-MAIL-FORWARD.1;
 * POST /api/email/tickets/[id]/forward — the same non-deprecated per-ticket
 * family as reply).
 *
 * THE ENVELOPE PASSES THROUGH UNTOUCHED, refusals included — the route owns
 * every rule (internal notes are 400d, unstored attachment ids refused, the
 * recipient cap, the 7 MiB ceiling re-measured on real bytes) and its error
 * strings are operator-facing sentences. lib/mail-forward.js is the screen's
 * courtesy copy of the predictable half; this wrapper re-implements none of
 * it.
 *
 * Send happens FIRST server-side and the ticket is deliberately not touched
 * (a forward is not an answer to the member — the thread stays in
 * needs-reply). The rare sent-but-unfiled branch answers success:false WITH
 * `data.sent: true` — surface it as "do not resend", exactly like compose.
 *
 * @param {object} args
 * @param {string}   args.ticketId      the ticket the message lives on
 * @param {string}   args.messageId     the ONE message being forwarded
 * @param {string[]} args.to            typed by the operator; at least one
 * @param {string[]} [args.cc]
 * @param {string[]} [args.bcc]
 * @param {string}   [args.note]        the covering note; optional by design
 * @param {string[]} [args.attachmentIds] ids of the ORIGINAL message's stored
 *   attachment rows (never paths, never bytes); default NONE
 * @param {string}   [args.locationId]
 */
export function forwardMessage({
  ticketId, messageId, to, cc, bcc, note, attachmentIds, locationId,
} = {}) {
  const body = { message_id: messageId, to }
  // Empty lists and a blank note stay off the wire — the route defaults them,
  // and the smallest body is the one shape nothing can misread.
  if (Array.isArray(cc) && cc.length > 0) body.cc = cc
  if (Array.isArray(bcc) && bcc.length > 0) body.bcc = bcc
  if (typeof note === 'string' && note.trim()) body.note = note
  if (Array.isArray(attachmentIds) && attachmentIds.length > 0) body.attachment_ids = attachmentIds
  return api(`/api/email/tickets/${ticketId}/forward`, { method: 'POST', body, locationId })
}

// ── Related conversations + merge (MAIL-REFINE.1 §03) ───────────────
//
// Built to the pinned contract (CONTRACTS-REFINE.md): the related route
// answers same-requester, same-location, caller-visible, unmerged threads
// newest first (capped at 10); the merge routes exist already and their
// refusal sentences are operator-facing — both wrappers pass the envelope
// through untouched.

/**
 * The requester's OTHER conversations at this location.
 *
 * `openCount` is null when the answer did not carry one — UNKNOWN, never 0:
 * relatedNudge (lib/mail-relate.js) shows nothing for null, and a confident
 * "no related conversations" off a malformed answer is exactly the silent
 * wrong verdict that rule exists to prevent. A failed call is a failure
 * (the route's own contract: failure is a real error, never an empty list).
 *
 * @returns {Promise<{success: true, related: object[], openCount: number|null}
 *                  |{success: false, error: string}>}
 */
export async function fetchRelatedConversations(ticketId, locationId) {
  const res = await api(`/api/email/mail/${ticketId}/related`, { locationId })
  if (!res.success || !res.data) {
    return { success: false, error: res.error || 'Could not check for related conversations' }
  }
  return {
    success: true,
    related: res.data.related || [],
    openCount: typeof res.data.open_count === 'number' ? res.data.open_count : null,
  }
}

/**
 * Fold one related conversation INTO another: POST at the SOURCE (the thread
 * being merged away), `into` naming the target being read. The server
 * reparents the messages and leaves a read-only tombstone pointing at the
 * target. Envelope passes through untouched — the picker runs these
 * sequentially via runMerges and stops on the first failure.
 */
export function mergeConversation(ticketId, intoTicketId, locationId) {
  return api(`/api/email/tickets/${ticketId}/merge`, {
    method: 'POST',
    body: { into: intoTicketId },
    locationId,
  })
}

/** Un-merge a conversation merged by the call above — the Undo on the
 * success notice (and nothing else; there is no persistent un-merge UI). */
export function unmergeConversation(ticketId, locationId) {
  return api(`/api/email/tickets/${ticketId}/merge`, {
    method: 'DELETE',
    locationId,
  })
}

// RETIRE-TICKETS.1 removed assignTicket + setTicketStatus + markTicketRead:
// assignment and the four-state lifecycle are not on the Mail surface (zero
// tickets were ever assigned in the queue's whole life), and read state is
// setConversationSeen above — which, unlike the old /read call, also mirrors
// \Seen into a connected real mailbox. The old routes live on as deprecated
// shims for bundles older than this one; nothing here may call them.

/**
 * MOBILE-MAILPARITY.1 — the Mail TAB badge's number: conversations somebody
 * wrote to us that nobody has answered yet, counting ONLY mailboxes the
 * caller can open, as the ESTATE sum via the same `?scope=all` the web
 * sidebar polls (Sidebar.jsx, MAIL-BADGE.1). Same per-location email_inbox
 * eligibility and mailbox scope as the digest, summed server-side — a Hatch
 * needs-reply badges while the phone sits on Stillorgan, and a coach at two
 * studios reads one number on both surfaces. (The single-studio wrapper this
 * replaced, getMailCount(locationId), had no caller left and was removed;
 * the per-studio tiles read fetchMailDigest.)
 *
 * Deliberately NO location header, like fetchMailDigest: scope=all resolves
 * eligibility per studio and ignores the active one. 🔴 One unanswerable
 * studio 500s the WHOLE response rather than summing a confidently smaller
 * number; passed through untouched so the poller keeps its last-known count.
 */
export function getEstateMailCount() {
  return api('/api/email/mail/count?scope=all')
}

/**
 * MOBILE-SIGHINT.1 — the viewer's per-studio signature contexts, for the
 * composers' "Added automatically" hint (lib/signature-hint.js resolves the
 * one that matters; this only fetches).
 *
 * It lives HERE rather than in a new me-preferences module because every
 * caller is a mail composer: the reply screen and the compose sheet already
 * take their whole wire surface from this file, and one more entry beats a
 * second client module whose only consumer is the mail surface. Nothing
 * else on the phone reads /api/me/preferences today.
 *
 * Each entry is ALREADY SERVER-RENDERED: `effective_text` is the exact text
 * a send from that studio appends, resolved with the studio's own name,
 * phone and links. Mobile cannot import `src/lib` and the renderer has no
 * `shared/` twin (CLAUDE.md Web/mobile boundary), so this is the whole
 * contract — render it verbatim, resolve nothing.
 *
 * 🔴 NO MODULE-LEVEL CACHE, deliberately. Web built one and removed it on
 * review: a module memo is per TAB (here, per app process), not per VIEWER,
 * so on a shared front-desk phone a sign-out and sign-in would show the next
 * operator the previous one's signature under their composer. The screens
 * fetch per mount instead.
 *
 * Failure is COSMETIC and answers []: the route appends the signature
 * server-side either way, so a blip must cost the hint and never the screen.
 * The plain envelope goes unread on purpose — there is nothing for a caller
 * to do with the error but hide a preview, which [] already says.
 */
export async function fetchSignatureContexts() {
  const res = await api('/api/me/preferences')
  if (!res.success) return []
  const contexts = res.data?.signature_contexts
  return Array.isArray(contexts) ? contexts : []
}

// ── Attachments (EMAIL-ATTACH-PREVIEW.1) ────────────────────────────
//
// The `email-attachments` bucket is PRIVATE and mobile holds no service-role
// key, so these two routes are the only way the phone ever reaches the bytes,
// and each URL expires in five minutes. They are minted on demand — when the
// operator taps a file — never at thread load, so a screen left open holds no
// live handles to anything.
//
// TWO ROUTES, TWO FIXED BEHAVIOURS, NO PARAMETERS. …/preview is always inline
// and only for the server's allow-list; the bare route always downloads and
// works for every type. Neither takes a disposition or any other Storage
// option, which is what stops a client asserting how a stranger's file should
// be served.

/**
 * An inline URL for a file the server says is previewable.
 *
 * A 404 here is NORMAL, not a fault: it is how the server says "no preview for
 * this type" (a Word document, a HEIC photo, an SVG). Callers fall back to
 * downloadTicketAttachment(), which is the path that works for everything.
 */
export async function previewTicketAttachment(ticketId, attachmentId, locationId) {
  const res = await api(
    `/api/email/tickets/${ticketId}/attachments/${attachmentId}/preview`,
    { locationId },
  )
  if (!res.success || !res.data?.url) {
    return { success: false, error: res.error || 'No preview is available for this file.' }
  }
  return { success: true, url: res.data.url, previewKind: res.data.preview_kind }
}

/**
 * A download URL for ANY stored file. The response carries
 * Content-Disposition: attachment, so handing it to Linking.openURL() lets the
 * OS save it rather than render it — which is what makes it the safe fallback
 * for the types no preview will ever cover.
 */
export async function downloadTicketAttachment(ticketId, attachmentId, locationId) {
  const res = await api(`/api/email/tickets/${ticketId}/attachments/${attachmentId}`, { locationId })
  if (!res.success || !res.data?.url) {
    return { success: false, error: res.error || 'That file could not be opened.' }
  }
  return { success: true, url: res.data.url }
}

// ── Outbound attachments (MOBILE-MAIL-A.1) ──────────────────────────
//
// Files STAFF send, on a reply or a new email. The bytes NEVER ride an /api
// body — Vercel 413s a request over ~4.5MB before any route runs, in plain
// text no client can parse — so this is the repo's standard three-step
// direct-to-storage flow (same shape as card receipts and invoices):
//
//   1. signOutboundAttachment() — POST /api/email/attachments/upload-sign.
//      The server authorises against the SEND'S OWN gate (the ticket a reply
//      belongs to, or the mailbox a new email leaves from) and mints a signed
//      token for a path IT built from the caller's own profile id. The phone
//      never proposes a path and can only ever address its own drafts.
//   2. uploadSignedAttachment() — device → private email-attachments bucket
//      directly, authorised by the token alone.
//   3. The reply/compose body carries the returned DRAFT REF
//      ({ draft_id, index, filename, mime }) on `attachments`. The send route
//      REBUILDS the identical key, re-measures the REAL downloaded bytes
//      against the 7MiB ceiling, and refuses BEFORE sending — so a draft that
//      never finished uploading refuses the send rather than sending without
//      the file.
//
// Sizing is the SCREENS' job before send (red chip, not a failed send —
// mail-compose.js owns the maths against the constants below); the server
// re-measures regardless, so these numbers are a courtesy, never the gate.

/**
 * The private bucket the drafts upload into. Mirrors EMAIL_ATTACHMENT_BUCKET
 * in src/lib/email-attachment-quota.js, which mobile cannot import — the
 * pinning test is what holds the two together.
 */
export const EMAIL_ATTACHMENT_BUCKET = 'email-attachments'

/**
 * The most RAW file bytes one email may carry across all its attachments
 * (7MiB — chosen server-side from Postmark's 10MB post-base64 ceiling) and
 * how many files. Both mirror src/lib/email-outbound-attachments.js.
 */
export const MAX_OUTBOUND_ATTACHMENT_TOTAL_BYTES = 7 * 1024 * 1024
export const MAX_OUTBOUND_ATTACHMENTS = 10

/**
 * A v4-SHAPED uuid for a draft slot — the sign route pins draft_id with the
 * uuidLike regex, so the shape is load-bearing; the VALUE carries no
 * authority (the caller's profile id, read from the session server-side, is
 * the key's security segment). That is why a Math.random fallback is
 * acceptable here: Hermes ships no crypto global, and the worst a collision
 * can do is overwrite the caller's OWN other draft.
 */
export function draftUuid() {
  const c = globalThis.crypto
  if (c?.randomUUID) return c.randomUUID()
  const bytes = new Uint8Array(16)
  if (c?.getRandomValues) {
    c.getRandomValues(bytes)
  } else {
    for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256)
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40 // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80 // RFC variant
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/**
 * Step 1 — authorise one file and get its signed upload slot.
 *
 * EXACTLY ONE of ticketId / mailboxId, the same rule the route 400s on:
 * a reply's file is authorised against its ticket, a new email's against the
 * mailbox it will leave from. Refused locally so a coding error surfaces on
 * the first tap rather than as a route sentence written for another case.
 *
 * Each call defaults to a FRESH draft uuid at index 0 — one file, one draft,
 * no shared state — which always yields distinct (draft_id, index) pairs, the
 * only thing the send's duplicate rule checks. A composer that prefers the
 * web picker's one-session-uuid + monotonic-slots scheme passes draftId +
 * index itself (index must stay < MAX_OUTBOUND_ATTACHMENTS; slots are never
 * reused after a remove).
 *
 * @param {object} args
 * @param {string} args.filename  display name (route bounds it at 255)
 * @param {number} args.size      the picker's byte count — used by the route
 *   only to refuse early with a useful sentence; the send re-measures
 * @param {string} [args.mime]    falls back to application/octet-stream; it
 *   must MATCH what uploadSignedAttachment stores, or the send route
 *   re-derives a different extension and refuses (deliberately)
 * @param {string} [args.ticketId]  authorise against an existing ticket
 * @param {string} [args.mailboxId] authorise against a sending mailbox
 * @param {string} [args.draftId]   see above; default = fresh uuid
 * @param {number} [args.index]     see above; default = 0
 * @param {string} [args.locationId]
 * @returns {Promise<{success: true, path: string, token: string,
 *                    draft: {draft_id: string, index: number,
 *                            filename: string, mime: string}}
 *                  |{success: false, error: string}>}
 *   `draft` is the ref the send body carries, verbatim.
 */
export async function signOutboundAttachment({
  filename, size, mime, ticketId, mailboxId, draftId, index = 0, locationId,
} = {}) {
  // Both or neither is a bug in the caller, not a request worth sending —
  // mirrors the route's own exactly-one rule.
  if (!ticketId === !mailboxId) {
    return { success: false, error: 'Attach a file to either an existing ticket or a mailbox, not both.' }
  }

  const draft = {
    draft_id: draftId || draftUuid(),
    index,
    filename,
    mime: mime || 'application/octet-stream',
  }
  const body = { ...draft, size }
  if (ticketId) body.ticket_id = ticketId
  else body.mailbox_id = mailboxId

  const res = await api('/api/email/attachments/upload-sign', { method: 'POST', body, locationId })
  if (!res.success || !res.data?.token || !res.data?.path) {
    return { success: false, error: res.error || 'Could not start that upload — try again.' }
  }
  return { success: true, path: res.data.path, token: res.data.token, draft }
}

/**
 * Step 2 — the bytes, device → bucket, authorised by the token alone.
 *
 * Reads the picked file into an ArrayBuffer first (upload-bytes.js — an RN
 * Blob from fetch(uri) does NOT transmit through uploadToSignedUrl and
 * stores a 0-byte object, the documented 2026-06-13 gotcha), and refuses an
 * empty read outright: a blank object would pass the sign, pass the upload,
 * and go out as a "sent" file with nothing in it.
 *
 * @param {object} signed  the whole success result of signOutboundAttachment
 * @param {string} fileUri expo-document-picker / expo-image-picker cache URI
 * @returns {Promise<{success: true, draft: object}|{success: false, error: string}>}
 *   `draft` is the same ref sign returned — handed back here so a picker can
 *   thread ONE object through both steps and keep only the final answer.
 */
export async function uploadSignedAttachment(signed, fileUri) {
  if (!signed?.path || !signed?.token || !signed?.draft) {
    return { success: false, error: 'That upload was not authorised — attach the file again.' }
  }

  let bytes
  try {
    bytes = await readFileAsArrayBuffer(fileUri)
  } catch (err) {
    return { success: false, error: `Could not read the selected file: ${err?.message || err}` }
  }
  if (!bytes || bytes.byteLength === 0) {
    return { success: false, error: 'The selected file appears to be empty — try picking it again.' }
  }

  try {
    const { error } = await supabase.storage
      .from(EMAIL_ATTACHMENT_BUCKET)
      .uploadToSignedUrl(signed.path, signed.token, bytes, { contentType: signed.draft.mime })
    if (error) {
      return { success: false, error: `Upload failed: ${error.message}` }
    }
  } catch (err) {
    return { success: false, error: `Upload failed: ${err?.message || err}` }
  }
  return { success: true, draft: signed.draft }
}
