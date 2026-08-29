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
 * @param {string} locationId  required by the route (400 without it)
 * @param {object} [opts]
 * @param {'inbox'|'needs_reply'|'archived'} [opts.view]
 * @returns {Promise<{success: boolean, data?: object[], mailboxes?: object[],
 *                    needsReplyCount?: number, error?: string}>}
 */
export async function listMail(locationId, { view } = {}) {
  if (!locationId) return { success: false, error: 'No active location' }
  const params = new URLSearchParams({ location_id: locationId })
  if (view) params.set('view', view)

  const res = await api(`/api/email/mail?${params.toString()}`, { locationId })
  if (!res.success) return { success: false, error: res.error || 'Failed to load email' }

  const mailboxes = res.data?.mailboxes || []
  return {
    success: true,
    data: ticketsToInboxRows({ tickets: res.data?.conversations || [], mailboxes }),
    mailboxes,
    needsReplyCount: res.data?.needs_reply_count ?? 0,
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
 */
export function replyToTicket(ticketId, text, { internal = false, locationId } = {}) {
  return api(`/api/email/tickets/${ticketId}/reply`, {
    method: 'POST',
    locationId,
    body: { text, internal: !!internal },
  })
}

// RETIRE-TICKETS.1 removed assignTicket + setTicketStatus + markTicketRead:
// assignment and the four-state lifecycle are not on the Mail surface (zero
// tickets were ever assigned in the queue's whole life), and read state is
// setConversationSeen above — which, unlike the old /read call, also mirrors
// \Seen into a connected real mailbox. The old routes live on as deprecated
// shims for bundles older than this one; nothing here may call them.

/**
 * The Mail tab badge number: conversations somebody wrote to us that nobody
 * has answered yet, at the caller's active location, counting ONLY mailboxes
 * they can open — the same predicate, from the same cheap count route, as
 * the web Mail badge. The response is passed through untouched so a polling
 * caller can keep its last-known count on failure rather than flashing a
 * confident zero.
 */
export function getMailCount(locationId) {
  return api('/api/email/mail/count', { locationId })
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
