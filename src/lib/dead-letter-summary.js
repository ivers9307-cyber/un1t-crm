// dead-letter-summary.js — pure, client-safe text summaries for
// webhook_dead_letter rows (DEADLETTER-UI.1).
//
// The payloads captured on the email paths carry FULL message bodies —
// TextBody/HtmlBody on an inbound email, the signed text_body on a
// sent-but-unfiled reply/compose/forward. The admin triage page must show an
// operator enough to act WITHOUT rendering any of that: html_body is only
// ever rendered through the sanctioned sanitiser path (sandboxed iframe +
// sanitize-html), and a triage table is not that path. So this module reduces
// each payload to short plain-text facts — addresses, subject, event names —
// and hard-caps every string it returns. The page renders them as ordinary
// React text nodes (escaped), never as markup.
//
// Pure and dependency-free on purpose: imported by the client table component
// as well as anything server-side that wants the same one-liner.

const MAX_SUMMARY = 160

/** Collapse whitespace and cap length; returns '' for empty/absent values. */
function clip(v, max = MAX_SUMMARY) {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim()
  if (!s) return ''
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

/** First address + a "+N more" tail, from an array of strings. */
function addrList(list) {
  const clean = (Array.isArray(list) ? list : []).map((a) => clip(a, 60)).filter(Boolean)
  if (clean.length === 0) return ''
  if (clean.length === 1) return clean[0]
  return `${clean[0]} +${clean.length - 1} more`
}

// Operator-facing names for the provider keys. Fallback is the raw key, so an
// unregistered provider still labels itself.
export const DEAD_LETTER_PROVIDER_LABELS = Object.freeze({
  postmark_inbound: 'Inbound email',
  postmark_queue: 'Email delivery event (retries exhausted)',
  postmark: 'Email delivery event (ingest failed)',
  email_ticket_reply: 'Ticket reply — sent, not filed',
  email_ticket_compose: 'Composed email — sent, not filed',
  email_ticket_forward: 'Forward — sent, not filed',
  glofox: 'Glofox',
  inbody: 'InBody',
  // ZOOMSYNC.4 — a Zoom Phone directory write Zoom permanently refused (4xx).
  // Not replayable: the same bytes get the same verdict. The fix is the phone
  // number on the contact; resolving the row here un-parks it for the next
  // nightly run.
  zoom_contact_sync: 'Zoom directory write refused',
})

export function providerLabel(provider) {
  return DEAD_LETTER_PROVIDER_LABELS[provider] || String(provider || 'unknown')
}

/**
 * One plain-text line describing what a dead-letter row captured — who/what,
 * never the body. Returns '' when there is nothing safe/useful to say (the
 * table shows the provider label and error either way).
 *
 * @param {{ provider?: string, event_type?: string, payload?: any }} row
 * @returns {string}
 */
export function summarizeDeadLetter(row) {
  const provider = row?.provider || ''
  const p = row?.payload && typeof row.payload === 'object' ? row.payload : {}

  // Inbound email (postmark_inbound): a Postmark inbound body. TextBody /
  // HtmlBody are deliberately never read.
  if (provider === 'postmark_inbound') {
    const from = clip(p.FromFull?.Email || p.From, 60)
    const to = addrList(
      Array.isArray(p.ToFull) && p.ToFull.length
        ? p.ToFull.map((t) => t?.Email)
        : String(p.To || '').split(',')
    )
    const subject = clip(p.Subject, 80)
    const parts = []
    if (from) parts.push(`From ${from}`)
    if (to) parts.push(`to ${to}`)
    const head = parts.join(' ')
    if (head && subject) return `${head} — “${subject}”`
    return head || (subject ? `“${subject}”` : '')
  }

  // Outbound delivery events (postmark_queue / postmark): Bounce,
  // SpamComplaint, SubscriptionChange, … The recipient is the fact that
  // matters — these rows carry suppressions and one-click unsubscribes.
  if (provider === 'postmark_queue' || provider === 'postmark') {
    const kind = clip(p.RecordType || row?.event_type, 40)
    const rcpt = clip(p.Recipient || p.Email, 60)
    const oneClick = p.RecordType === 'SubscriptionChange' && p.SuppressSending
    const label = oneClick ? 'One-click unsubscribe' : kind
    if (label && rcpt) return `${label} for ${rcpt}`
    return label || ''
  }

  // Sent-but-unfiled ticket mail (email_ticket_reply/compose/forward): the
  // payload is the re-fileable record — recipients, subject, and the full
  // signed text_body. Only the envelope is summarised.
  if (provider === 'email_ticket_reply' || provider === 'email_ticket_compose' || provider === 'email_ticket_forward') {
    const to = addrList(p.recipients?.to)
    const subject = clip(p.subject, 80)
    const ticket = clip(p.ticket_id, 40)
    const parts = []
    if (subject) parts.push(`“${subject}”`)
    if (to) parts.push(`to ${to}`)
    const head = parts.join(' ')
    const tail = ticket ? `not filed on ticket ${ticket}` : 'not filed'
    return head ? `${head} — delivered, ${tail}` : `Delivered, ${tail}`
  }

  // Zoom directory write (zoom_contact_sync): the payload is our own job, so
  // its shape is known exactly. The number is the fact that matters — it is
  // what an operator has to go and fix on the contact.
  if (provider === 'zoom_contact_sync') {
    const op = clip(p.op || row?.event_type, 20)
    const number = clip(p.e164, 24)
    const contact = clip(p.contactId, 40)
    const head = [op, number].filter(Boolean).join(' ')
    if (!head) return ''
    return contact ? `${head} — contact ${contact}` : head
  }

  // Unknown providers: say nothing rather than risk echoing a payload field
  // that was never meant for display. Provider label + error carry the story.
  return ''
}
