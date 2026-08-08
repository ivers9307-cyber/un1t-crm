// Email TICKET API helpers for mobile (EMAIL-TICKET-M.1, was INBOX-EMAIL-M.1).
//
// The CRM's email channel is a ticket system now (/communications/tickets on
// web). Mobile keeps email — backed by tickets, not the deprecated
// email_conversations rows this file used to read.
//
// Same posture as before: the email_* tables carry a RESTRICTIVE deny-all
// policy for authenticated/anon, so mobile never reads them direct. Every call
// rides the /api/email/tickets* routes via the api() helper, which carries the
// Bearer token + x-active-location + x-impersonate-target headers. Those routes
// are service-role (no RLS), and they gate on the top-level `email_inbox`
// permission plus a per-account email_mailbox_access grant — the SAME two
// levels the web inbox is behind. Screens must gate on `email_inbox` too
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
//   • reading a ticket no longer clears its unread badge as a side effect;
//     markTicketRead() is its own call, so a GET stays a GET.

import { api } from './api'
import { ticketsToInboxRows } from './email-tickets'

// Re-exported so screens that already import their display helper from here
// keep one import for "the email surface". requesterLabel is the ticket-era
// precedence: requester_name → requester_email.
export { requesterLabel as emailDisplayName } from './email-tickets'

// The four the route whitelists. Anything else is a 400, and omitting the
// param entirely is the live queue (open + pending) — which is what the Email
// tab lands on, so nothing here sends one by default. The screen's chips map
// their id onto these via ticketViewWire() in ./email-tickets.
export const TICKET_VIEWS = Object.freeze(['unassigned', 'mine', 'needs_reply', 'closed'])

/**
 * The studio's ticket queue, shaped into rows for the Email tab's list.
 *
 * A caller with no visible mailboxes gets an empty list, not an error — a
 * studio that does not do email and a coach with no account grants are both
 * normal states.
 *
 * @param {string} locationId  required by the route (400 without it)
 * @param {object} [opts]
 * @param {'unassigned'|'mine'|'needs_reply'|'closed'} [opts.view]
 * @returns {Promise<{success: boolean, data?: object[], mailboxes?: object[], error?: string}>}
 */
export async function listTickets(locationId, { view } = {}) {
  if (!locationId) return { success: false, error: 'No active location' }
  const params = new URLSearchParams({ location_id: locationId })
  if (view) params.set('view', view)

  const res = await api(`/api/email/tickets?${params.toString()}`, { locationId })
  if (!res.success) return { success: false, error: res.error || 'Failed to load email' }

  const mailboxes = res.data?.mailboxes || []
  return {
    success: true,
    data: ticketsToInboxRows({ tickets: res.data?.tickets || [], mailboxes }),
    mailboxes,
  }
}

/**
 * One ticket and its thread, oldest message first.
 *
 * Does NOT clear the unread badge — call markTicketRead() for that.
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

/**
 * Claim ('me'), release (null) or reassign (a profile id) — EMAIL-ASSIGN.1.
 * Same contract as web; the route enforces who may do which (claim = anyone
 * who can see the ticket, reassign = elevated) and answers 409 when somebody
 * else claimed it first.
 */
export async function assignTicket(ticketId, assignee, { locationId } = {}) {
  const res = await api(`/api/email/tickets/${ticketId}/assign`, {
    method: 'POST',
    locationId,
    body: { assignee },
  })
  if (!res.success) return { success: false, error: res.error || 'Failed to change assignee' }
  return {
    success: true,
    ticket: res.data?.ticket || null,
    assigneeName: res.data?.assignee_name || null,
  }
}

/**
 * Move a ticket through its lifecycle: open | pending | solved | closed.
 *
 * This is the ONLY way a ticket leaves the queue — nothing auto-closes
 * anywhere in this feature by design, so a surface that hides this leaves
 * tickets to age forever.
 */
export function setTicketStatus(ticketId, status, locationId) {
  return api(`/api/email/tickets/${ticketId}/status`, {
    method: 'POST',
    locationId,
    body: { status },
  })
}

/** Zero the unread badge. Idempotent; safe to fire on open. */
export function markTicketRead(ticketId, locationId) {
  return api(`/api/email/tickets/${ticketId}/read`, { method: 'POST', locationId })
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
