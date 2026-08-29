// MOBILE-MAIL-COMPOSE.1 — pure rules for the compose sheet (mockup §05):
// recipient pill state, send validation, and attachment size maths. The screen
// (app/(staff)/email/compose.jsx) renders what these functions decide and does
// nothing else; every branchable decision lives here so it runs under vitest
// and can be mutation-tested.
//
// THE SERVER IS THE GATE, THIS FILE IS THE AFFORDANCE. The compose route
// (POST /api/email/tickets/compose) validates addresses with the strict Zod
// email schema, enforces the 25-recipient cap and dedupes across To/Cc/Bcc —
// none of that is re-implemented here (CONTRACTS: surface refusals, don't
// re-derive them). What this file DOES own is the phone-side experience the
// route cannot give: a pill that will obviously bounce off the route is
// refused before it forms, a paste splits into pills, and an oversize file is
// a red chip before send rather than a 400 after typing.
//
// DELIBERATE RESTATEMENTS, not imports (mobile cannot reach src/lib —
// CLAUDE.md, `shared/` is the seam and none of this is exported there):
//   • normalizeAddress mirrors src/lib/email-recipients.js — trim, unwrap
//     "Name <addr>", lowercase, validate. The regex is Zod's own email rule,
//     the same one the route's schema applies, so a pill that forms here is
//     one the route will take and a value the route would 400 never becomes a
//     pill. If the two ever drift the failure is soft: the route's inline
//     error renders, nothing is sent.
//   • MAX_ATTACHMENT_TOTAL_BYTES / MAX_ATTACHMENTS mirror
//     src/lib/email-outbound-attachments.js (7 MiB raw bytes chosen from
//     Postmark's 10 MB post-base64 ceiling; 10 files). The server re-measures
//     the true downloaded bytes at send — these figures exist so the operator
//     finds out while choosing the file, never after writing the email.
//
// No React Native imports — this file runs under vitest's node environment
// (vitest.config.js includes mobile/lib).

import { formatAttachmentSize } from './email-tickets'

// ── Recipients ───────────────────────────────────────────────────────

// Zod's email regex (the route validates with the same rule via its schema).
// Stricter than the inbound-mail parser on purpose: this gates what WE put on
// the wire, where an unparseable address is an operator typo to refuse.
const ADDRESS_RE =
  /^(?!\.)(?!.*\.\.)([A-Za-z0-9_'+\-.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9-]*\.)+[A-Za-z]{2,}$/

/**
 * Lowercased, trimmed address — or null when it is not one.
 * Accepts the "Display Name <addr@example.com>" form operators paste out of
 * a mail client; the angle-bracketed address is the whole value.
 *
 * @param {unknown} raw
 * @returns {string|null}
 */
export function normalizeAddress(raw) {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  const angled = trimmed.match(/<([^<>]+)>\s*$/)
  const candidate = (angled ? angled[1] : trimmed).trim().toLowerCase()
  return ADDRESS_RE.test(candidate) && candidate.length <= 320 ? candidate : null
}

/**
 * Commit typed/pasted text into pills. Splits on commas, semicolons and any
 * whitespace (a paste out of a mail client carries all three), dedupes
 * case-insensitively against existing pills AND within the paste, and reports
 * the tokens it could not use — an invalid address silently dropped is a
 * person the operator never learns was left off.
 *
 * A free-typed pill carries no name and no tag; only addContactPill knows who
 * somebody is.
 *
 * @param {{address:string}[]} pills
 * @param {string} text
 * @returns {{ pills: object[], invalid: string[] }}
 */
export function addRecipients(pills, text) {
  const tokens = String(text || '').split(/[\s,;]+/).filter(Boolean)
  if (tokens.length === 0) return { pills, invalid: [] }

  const seen = new Set((pills || []).map(p => p.address))
  const next = [...(pills || [])]
  const invalid = []
  for (const token of tokens) {
    const address = normalizeAddress(token)
    if (!address) {
      invalid.push(token)
      continue
    }
    if (seen.has(address)) continue
    seen.add(address)
    next.push({ address, name: null, tag: null })
  }
  return { pills: next, invalid }
}

/**
 * Pill a directory contact (a tapped suggestion). Refuses one with no usable
 * address — a pill that cannot be sent to is a lie waiting for the send
 * button. Adding an address already pilled is a no-op, whichever of the two
 * paths pilled it first.
 *
 * @param {{address:string}[]} pills
 * @param {{name?:string, email?:string, pipeline_stage_slug?:string}} contact
 * @returns {{ pills: object[], error: string|null }}
 */
export function addContactPill(pills, contact) {
  const address = normalizeAddress(contact?.email)
  if (!address) {
    return { pills: pills || [], error: 'That contact has no email address on file.' }
  }
  if ((pills || []).some(p => p.address === address)) {
    return { pills, error: null }
  }
  return {
    pills: [...(pills || []), { address, name: contact?.name || null, tag: contactTag(contact) }],
    error: null,
  }
}

/** Remove one pill by address. */
export function removePill(pills, address) {
  return (pills || []).filter(p => p.address !== address)
}

/**
 * Remove the LAST pill — the backspace-on-empty-input gesture every mail app
 * teaches. Returns what was removed so the screen can drop it back into the
 * input for editing.
 */
export function popPill(pills) {
  const list = pills || []
  if (list.length === 0) return { pills: list, removed: null }
  return { pills: list.slice(0, -1), removed: list[list.length - 1] }
}

/**
 * The mono-circle initials on a pill/suggestion (mockup §05: "SO", "ND").
 * Name first, then the address's local part, then '?' — the circle must never
 * render blank.
 */
export function pillInitials(name, address) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean)
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
  if (parts.length === 1) return parts[0][0].toUpperCase()
  const local = String(address || '').split('@')[0]
  return local ? local[0].toUpperCase() : '?'
}

// ── Suggestion tagging + filtering ───────────────────────────────────

// The stages that mean "this person pays us" (shared/pipeline-classifier.js
// taxonomy): member + converted are the classic pair (the MEMBER_STAGES
// precedent in shared/hr-session-report.js), pack_member because buying a
// Class Pack IS a conversion (FUNNEL.3), returning_converted for the
// returning board's end state. Everyone else — every funnel stage, the
// off-funnel piles, and a contact with no stage at all — is a LEAD. Display
// only: knowing which you are writing to changes what you say, nothing more.
const MEMBER_STAGES = new Set(['member', 'converted', 'pack_member', 'returning_converted'])

/** 'member' | 'lead' — the suggestion row's tag. */
export function contactTag(contact) {
  return MEMBER_STAGES.has(contact?.pipeline_stage_slug) ? 'member' : 'lead'
}

/**
 * What searchContacts returned, minus what the picker cannot use: contacts
 * with no sendable address (a suggestion that errors when tapped) and
 * contacts already pilled (a double-add affordance). Order is the server's.
 *
 * @param {object[]} contacts
 * @param {{ pills?: {address:string}[], limit?: number }} opts
 */
export function filterContactSuggestions(contacts, { pills = [], limit = 6 } = {}) {
  const pilled = new Set((pills || []).map(p => p.address))
  const out = []
  for (const c of contacts || []) {
    const address = normalizeAddress(c?.email)
    if (!address || pilled.has(address)) continue
    out.push(c)
    if (out.length >= limit) break
  }
  return out
}

/**
 * Search only from two typed characters — one letter matches half the
 * directory and the flicker of a giant list under the To field reads as a
 * glitch, not help.
 */
export function shouldSearchContacts(pending) {
  return String(pending || '').trim().length >= 2
}

// ── Attachments (size maths) ─────────────────────────────────────────

/**
 * The most RAW file bytes one email may carry — a restatement of the web's
 * MAX_OUTBOUND_ATTACHMENT_TOTAL_BYTES (7 MiB, derived from Postmark's 10 MB
 * post-base64 message ceiling; the derivation lives in
 * src/lib/email-outbound-attachments.js). Enforced server-side on the true
 * downloaded bytes; checked here so the answer arrives as a red chip while
 * picking, not a failed send after typing.
 */
export const MAX_ATTACHMENT_TOTAL_BYTES = 7 * 1024 * 1024

/** How many files one email may carry (web MAX_OUTBOUND_ATTACHMENTS). */
export const MAX_ATTACHMENTS = 10

/**
 * Turn picker assets into attachment entries.
 *
 * THE OVERSIZE ANSWER IS A CHIP, NOT A REFUSAL (mockup §05 note 4): a file
 * that would push the sendable total past the ceiling still appears, status
 * 'oversize', wearing the sentence that names the limit — and it never
 * uploads, never counts against the budget (see attachmentBudget) and blocks
 * the send until removed (composeSendState). The FILE CAP is the one hard
 * refusal: an eleventh chip would have to be a chip that can never send no
 * matter what is removed, which is not a state, it is clutter.
 *
 * `nextIndex` is a monotonic counter the screen holds — keys are never reused
 * after a removal, so two chips can never address one entry.
 *
 * @param {object[]} existing  current entries
 * @param {{uri:string, name?:string, size?:number, mimeType?:string}[]} picked
 *   expo-document-picker / expo-image-picker assets
 * @param {number} nextIndex
 * @returns {{ entries: object[], error: string|null, nextIndex: number }}
 */
export function classifyPickedFiles(existing, picked, nextIndex) {
  const entries = []
  let error = null
  let index = Number.isInteger(nextIndex) ? nextIndex : 0
  let running = attachmentBudget(existing).used
  let count = (existing || []).length

  for (const asset of picked || []) {
    if (count >= MAX_ATTACHMENTS) {
      error = `You can attach up to ${MAX_ATTACHMENTS} files to one email.`
      break
    }
    const size = Number(asset?.size)
    const filename = asset?.name || 'file'
    // An unreadable size refuses (oversize), never rides free — the same
    // direction the web's exceedsOutboundTotal fails in.
    const fits = Number.isFinite(size) && size >= 0 && running + size <= MAX_ATTACHMENT_TOTAL_BYTES
    const entry = {
      key: `att-${index}`,
      uri: asset?.uri || null,
      filename,
      mime: asset?.mimeType || 'application/octet-stream',
      size: Number.isFinite(size) ? size : 0,
      status: fits ? 'uploading' : 'oversize',
      error: fits ? null : oversizeChipError(filename, size),
      ref: null,
    }
    if (fits) running += size
    index += 1
    count += 1
    entries.push(entry)
  }
  return { entries, error, nextIndex: index }
}

/** The red chip's sentence — names the limit, because "too large" with no
 * number is a message people retry unchanged (web outboundFileTooLargeError,
 * restated). */
function oversizeChipError(filename, size) {
  const shown = Number.isFinite(size) && size > 0 ? formatAttachmentSize(size) : 'of unknown size'
  return `${filename} is ${shown} — one email can carry `
    + `${formatAttachmentSize(MAX_ATTACHMENT_TOTAL_BYTES)} of attachments in total. `
    + 'Remove it, or send it in a second email.'
}

/**
 * How much of the ceiling the SENDABLE files spend — uploading + ready only.
 * A failed or oversize chip will never leave the phone, so its bytes must not
 * block a later file that genuinely fits.
 */
export function attachmentBudget(files) {
  const used = (files || []).reduce((sum, f) => (
    f?.status === 'uploading' || f?.status === 'ready' ? sum + (Number(f.size) || 0) : sum
  ), 0)
  return {
    used,
    limit: MAX_ATTACHMENT_TOTAL_BYTES,
    remaining: Math.max(0, MAX_ATTACHMENT_TOTAL_BYTES - used),
    over: used > MAX_ATTACHMENT_TOTAL_BYTES,
  }
}

/** Is anything still moving? Send is disabled on this. */
export function hasPendingUploads(files) {
  return (files || []).some(f => f?.status === 'uploading')
}

/** A failed upload or an oversize chip on screen — send stays blocked so the
 * email can never quietly go with a subset of what the strip shows. */
export function hasBlockedAttachments(files) {
  return (files || []).some(f => f?.status === 'failed' || f?.status === 'oversize')
}

/**
 * The draft refs the compose body carries, for the files that are actually in
 * the bucket. `ref` is whatever signOutboundAttachment (lib/email-api.js)
 * answered for that file — this module never invents or reshapes one.
 */
export function readyAttachmentRefs(files) {
  return (files || []).filter(f => f?.status === 'ready').map(f => f.ref)
}

// ── Send validation ──────────────────────────────────────────────────

/**
 * May this sheet send, and if not, why — ONE derivation for the button's
 * disabled state and the sentence beside it, so they cannot disagree.
 *
 * The reasons are ordered by what the operator should fix first. The
 * 25-recipient cap is deliberately NOT here: the server enforces it and its
 * refusal renders inline (sendFailureMessage) — re-implementing the cap is
 * how two limits drift.
 *
 * @param {{ mailboxId?: string|null, pills?: object[], subject?: string,
 *           text?: string, files?: object[] }} state
 * @returns {{ canSend: boolean, reason: string|null }}
 */
export function composeSendState({ mailboxId, pills, subject, text, files } = {}) {
  if (!mailboxId) return { canSend: false, reason: 'Choose the account this sends from.' }
  if (!(pills || []).length) return { canSend: false, reason: 'Add at least one recipient.' }
  if (!String(subject || '').trim()) return { canSend: false, reason: 'Give it a subject.' }
  if (!String(text || '').trim()) return { canSend: false, reason: 'Write the email.' }
  if (hasPendingUploads(files)) {
    return { canSend: false, reason: 'Waiting for a file to finish uploading…' }
  }
  if (hasBlockedAttachments(files)) {
    return { canSend: false, reason: 'Remove the file that cannot be sent.' }
  }
  return { canSend: true, reason: null }
}

/**
 * What the operator reads when the route said no. Zod issues first — the route
 * answers "Invalid request body" with the field detail in `issues`, and the
 * bare sentence names no field. Everything else (the recipient cap, a Postmark
 * refusal, the sent-but-unfiled "Do not resend" copy) arrives as `error` and
 * passes through untouched.
 */
export function sendFailureMessage(res) {
  const issues = Array.isArray(res?.issues) ? res.issues.map(i => i?.message).filter(Boolean) : []
  if (issues.length) return issues.join('; ')
  if (res?.error) return res.error
  return 'Could not send that — check your connection and try again.'
}

// ── Mailbox picker ───────────────────────────────────────────────────

/**
 * Which account the sheet opens on: an explicit initial id when it is in the
 * caller's visible set, else the location's default, else the first, else
 * null. Same precedence as the web composer (TicketCompose.jsx) — the two
 * surfaces must not open on different accounts for the same person.
 */
export function defaultMailboxId(mailboxes, initialId = null) {
  const boxes = mailboxes || []
  if (initialId && boxes.some(m => m?.id === initialId)) return initialId
  return boxes.find(m => m?.is_default)?.id || boxes[0]?.id || null
}

/** The From row shows the ADDRESS — which address a member hears from is the
 * business decision the field exists for; the label is the fallback. */
export function mailboxDisplay(mailbox) {
  if (!mailbox) return 'Mailbox'
  return mailbox.address || mailbox.label || 'Mailbox'
}

// ── Dirty state ──────────────────────────────────────────────────────

/**
 * Does closing this sheet cost the operator anything? Half-typed recipient
 * text counts (it is the field they were mid-thought in); whitespace-only
 * subject/body does not — confirming the discard of nothing is noise.
 */
export function composeIsDirty({ pills, pending, subject, text, files } = {}) {
  return Boolean(
    (pills || []).length
    || String(pending || '').trim()
    || String(subject || '').trim()
    || String(text || '').trim()
    || (files || []).length,
  )
}
