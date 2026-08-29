// mobile/lib/mail-forward.js — MOBILE-MAIL-FORWARD.1: every branchable
// decision the forward screen (app/(staff)/email/forward.jsx) makes, off-screen
// and vitest-tested (mobile screens have no render harness — contract rule 6).
//
// THE SERVER IS THE GATE, THIS FILE IS THE AFFORDANCE — the forward route
// (POST /api/email/tickets/[id]/forward) refuses notes, unstored files and an
// over-budget set with operator-facing sentences, and this file exists so the
// screen predicts every one of those refusals BEFORE the wire. A refused send
// the screen could have foreseen is a bug, not a safety net.
//
// DELIBERATE RESTATEMENTS of src/lib/email-forward.js, which mobile cannot
// import (CLAUDE.md — `shared/` is the seam and none of this is exported
// there). The three rules that must not drift, and what pins each:
//
//   1. AN INTERNAL NOTE CANNOT BE FORWARDED (canForwardMessage — web's
//      src/lib/ticket-display.js rule verbatim). A note is staff-to-staff text
//      that was never sent to anybody; mailing it to a third party under the
//      studio's own address is the single worst thing this surface could do.
//      The route 400s it too — that is the gate, this is why the affordance
//      never even renders on a note.
//   2. A FILE WITH NO STORED BYTES IS NEVER OFFERED (forwardableAttachments).
//      Over quota on arrival, over the per-file ceiling, or pruned — the row
//      is still LISTED (unforwardableAttachments, disabled, reason in words)
//      because a file that vanished would have staff telling a member "you
//      never sent that"; it is just never a checkbox, because a checkbox for
//      it would promise a file that cannot be sent.
//   3. EVERYTHING WHEN EVERYTHING FITS, NOTHING WHEN IT DOES NOT
//      (defaultForwardSelection — the web composer's rule). An inbound email
//      can carry 25 MB; one outbound email carries 7 MiB, so "forward
//      everything" is not always available. A greedy subset would be files the
//      operator did not DECIDE to leave out — the silent drop this whole
//      feature exists to make impossible. The operator chooses; the running
//      total names the numbers that make the choice theirs.
//
// FAILURE-MESSAGE MAPPING IS REUSED, NOT RESTATED: the screen renders route
// refusals through sendFailureMessage in ./mail-compose (round-1 audit rule —
// reuse the compose machinery; one mapping, no drift). Same for the recipient
// pill state: addRecipients / removePill / popPill / pillInitials /
// filterContactSuggestions / shouldSearchContacts all come from mail-compose.
//
// No React Native imports — this file runs under vitest's node environment.

import { formatAttachmentSize } from './email-tickets'

/**
 * The most RAW bytes one outbound email may carry — a restatement of
 * ./email-api.js's MAX_OUTBOUND_ATTACHMENT_TOTAL_BYTES (itself mirroring
 * src/lib/email-outbound-attachments.js). NOT imported from email-api: that
 * module pulls './supabase' — the RN runtime, which must never load under
 * vitest — into every consumer of this pure lib. The test file pins the pair
 * equal instead, so they cannot drift. The server re-measures the true bytes
 * at send time either way; this figure is what turns its refusal into a
 * disabled button with a sentence, before the operator types a note.
 */
export const MAX_FORWARD_ATTACHMENT_TOTAL_BYTES = 7 * 1024 * 1024

/**
 * Can this message be forwarded as mail at all? Web's canForwardMessage
 * (src/lib/ticket-display.js), verbatim: everything except an internal note.
 */
export function canForwardMessage(message) {
  return !!message && !message.is_internal_note
}

/**
 * What the thread's ⋮ overflow acts on: the NEWEST forwardable message.
 * Messages arrive oldest-first from getTicket, so this walks from the end —
 * skipping trailing internal notes, because "forward" from the thread menu
 * means the correspondence on top, never the staff commentary about it.
 */
export function newestForwardableMessage(messages) {
  const list = Array.isArray(messages) ? messages : []
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (canForwardMessage(list[i])) return list[i]
  }
  return null
}

/* ───────────────────── the preview card ───────────────────── */

/**
 * "Fwd: " exactly once — web's forwardSubject, restated for the preview card
 * (the server builds the real outbound subject with its own copy of this
 * rule; showing a different line here would preview a mail that never goes).
 * Every prefix a real client emits counts as already-forwarded; `Re:` is NOT
 * stripped — "Fwd: Re: Refund" is the truthful description of forwarding a
 * reply.
 */
export function forwardSubject(subject) {
  const s = String(subject || '').trim()
  if (!s) return 'Fwd: (no subject)'
  return /^\s*(fwd?|fw)\s*:/i.test(s) ? s : `Fwd: ${s}`
}

// How much of the original the preview card quotes. A preview, not the mail:
// the server quotes up to 20,000 chars on the wire — this card only has to
// show the operator WHAT they are passing on, so it folds far sooner.
export const FORWARD_PREVIEW_MAX_LINES = 6
export const FORWARD_PREVIEW_MAX_CHARS = 500

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** '25 Aug 2026, 09:05', or '' for garbage — never "Invalid Date". Local Date
 * methods only; no ISO round trip (CLAUDE.md timezones). */
function previewWhen(iso) {
  const d = new Date(iso || '')
  if (Number.isNaN(d.getTime())) return ''
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${hh}:${mm}`
}

/**
 * Everything the read-only quoted-preview card shows: who wrote it, when, the
 * subject it will leave under, and the first lines of the text. The excerpt
 * is `text_body` ONLY — same as the mail itself (the web module's "forwarding
 * is plain text" decision): what the card previews and what goes out are the
 * same thing, so there is nothing for the recipient to be surprised by.
 *
 * @param {object|null} message
 * @returns {{ from: string, when: string, subject: string,
 *             excerpt: string, excerptTruncated: boolean }}
 */
export function forwardPreviewMeta(message) {
  const m = message || {}
  const raw = String(m.text_body || '').replace(/\r\n/g, '\n').trim()

  let excerpt = raw
  let truncated = false
  const lines = raw.split('\n')
  if (lines.length > FORWARD_PREVIEW_MAX_LINES) {
    excerpt = lines.slice(0, FORWARD_PREVIEW_MAX_LINES).join('\n')
    truncated = true
  }
  if (excerpt.length > FORWARD_PREVIEW_MAX_CHARS) {
    excerpt = excerpt.slice(0, FORWARD_PREVIEW_MAX_CHARS)
    truncated = true
  }

  return {
    from: m.from_email || 'Unknown sender',
    when: previewWhen(m.sent_at || m.created_at),
    subject: forwardSubject(m.subject),
    excerpt: excerpt || '(no text content)',
    excerptTruncated: truncated,
  }
}

/* ───────────────────── which files may ride ───────────────────── */

/**
 * The original's attachments that COULD be forwarded — stored bytes only.
 * Accepts either vocabulary for the same fact (web rule): the ticket detail
 * route exposes `stored` (it never returns storage_path to a client — the
 * bucket is private), while a raw row would carry `storage_path`.
 */
export function forwardableAttachments(rows) {
  return (Array.isArray(rows) ? rows : []).filter(r => r && (r.stored || r.storage_path))
}

/**
 * The rows with no bytes — listed DISABLED with their reason, never hidden.
 * The server refuses their ids outright ("was never stored, so there is
 * nothing to forward"), so offering one would be promising a refusal.
 */
export function unforwardableAttachments(rows) {
  return (Array.isArray(rows) ? rows : []).filter(r => r && !(r.stored || r.storage_path))
}

/** How much of the ceiling a chosen set spends — the screen's running total. */
export function forwardBudget(rows) {
  const used = (Array.isArray(rows) ? rows : [])
    .reduce((sum, r) => sum + (Number.isFinite(Number(r?.size_bytes)) ? Number(r.size_bytes) : 0), 0)
  return {
    used,
    limit: MAX_FORWARD_ATTACHMENT_TOTAL_BYTES,
    over: used > MAX_FORWARD_ATTACHMENT_TOTAL_BYTES,
  }
}

/**
 * The pre-ticked set: every stored file when the whole set fits, NOTHING when
 * it does not (see rule 3 in the header — a greedy subset is a silent drop).
 *
 * @param {object[]} rows already filtered by forwardableAttachments()
 * @returns {string[]} attachment ids
 */
export function defaultForwardSelection(rows) {
  const list = Array.isArray(rows) ? rows : []
  if (list.length === 0) return []
  return forwardBudget(list).over ? [] : list.map(r => r.id)
}

/** One checkbox tap. */
export function toggleForwardSelection(selected, id) {
  const list = Array.isArray(selected) ? selected : []
  return list.includes(id) ? list.filter(x => x !== id) : [...list, id]
}

/**
 * Selected ids → rows, in the ORIGINAL's attachment order (web rule: the
 * forwarded message's chips read the same way round as the message they came
 * from, whatever order the taps happened in).
 */
export function selectedForwardRows(rows, selected) {
  const wanted = new Set(Array.isArray(selected) ? selected : [])
  return (Array.isArray(rows) ? rows : []).filter(r => wanted.has(r?.id))
}

/* ───────────────────── the send gate ───────────────────── */

/**
 * THE send gate — one derivation for the button's disabled state and the
 * submit guard, so they cannot disagree. Sentence reasons, rendered verbatim
 * under the dock (the compose screen's pattern).
 *
 * ≥1 To pill (a forward's audience is entirely the operator's choice — nothing
 * is derived from the thread), and the chosen files must fit the ceiling. The
 * note is OPTIONAL: "here, look at this" is a legitimate forward, and the
 * route's schema agrees. `sending`/`sent` stay screen state, exactly as the
 * compose screen holds them beside composeSendState.
 *
 * @param {{ pills?: {address:string}[], selectedRows?: object[] }} state
 * @returns {{ canSend: boolean, reason: string|null }}
 */
export function forwardSendState({ pills, selectedRows } = {}) {
  if (!(pills || []).length) return { canSend: false, reason: 'Add at least one recipient.' }
  const budget = forwardBudget(selectedRows)
  if (budget.over) {
    // Both numbers and the remedy — mirrors the web's forwardSizeError intent:
    // the answer here is "untick one", not "remove a file you attached".
    return {
      canSend: false,
      reason: `Those files come to ${formatAttachmentSize(budget.used)}, and one email can carry `
        + `${formatAttachmentSize(budget.limit)} of attachments. Untick one, or forward them across two emails.`,
    }
  }
  return { canSend: true, reason: null }
}
