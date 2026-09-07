// MAIL-REPLY-QUOTE.1 — what a reply quotes and what it threads onto.
//
// A mail client replies to the MOST RECENT message in the conversation,
// whoever sent it, quotes its text underneath the new words, and threads
// with In-Reply-To/References pointing at it. This module is that, pure.
// The reply route loads the anchor, builds the body and headers here, sends,
// and stores exactly what it sent.
//
// Only plain text is ever quoted (spec, "Quoting"): re-sending a stranger's
// sanitised HTML from the studio's own address is the forward path's refusal
// too, for the same reason.

import { forwardedBody, FORWARD_TRUNCATED_NOTE } from '@/lib/email-forward'

// Postmark mints the RFC Message-ID of everything it sends as
// <{MessageID}@mtasv.net>. Evidence: Richard's Gmail reply of 2026-09-07 had
// In-Reply-To <80d4bc38-…@mtasv.net>, the postmark_message_id of our compose.
export const POSTMARK_MESSAGE_ID_DOMAIN = 'mtasv.net'

const NO_TEXT = '(no text content)'

function bracket(id) {
  const s = String(id || '').trim()
  if (!s) return ''
  return s.startsWith('<') ? s : `<${s}>`
}

/**
 * The message a reply is a reply to: newest by created_at, notes excluded.
 * created_at, not sent_at — an inbound sent_at is the sender's own Date header.
 * @param {object[]|null} messages
 * @returns {object|null}
 */
export function selectReplyAnchor(messages) {
  if (!Array.isArray(messages)) return null
  let best = null
  for (const m of messages) {
    if (!m || m.is_internal_note) continue
    if (!best || String(m.created_at || '') > String(best.created_at || '')) best = m
  }
  return best
}

/**
 * The anchor's RFC Message-ID, bracketed, or null.
 * rfc_message_id wins (inbound rows, SMTP-sent rows). A Postmark-sent OUTBOUND
 * row has only postmark_message_id; derive it. Never for inbound rows: their
 * postmark_message_id is Postmark's inbound record id, not a Message-ID.
 */
export function anchorMessageId(message) {
  if (!message) return null
  if (message.rfc_message_id) return bracket(message.rfc_message_id)
  if (message.direction === 'outbound' && message.postmark_message_id) {
    return `<${String(message.postmark_message_id).trim()}@${POSTMARK_MESSAGE_ID_DOMAIN}>`
  }
  return null
}

/**
 * RFC 5322 §3.6.4: the parent's References (or its In-Reply-To when it has
 * none) followed by the parent's Message-ID.
 * @returns {string} '' when the anchor has no id at all
 */
export function replyReferences(message) {
  const id = anchorMessageId(message)
  if (!id) return ''
  const chain = String(message.references_header || '').trim()
    || bracket(message.in_reply_to)
  return chain ? `${chain} ${id}` : id
}

/** Postmark-shaped header list; [] when nothing can be threaded. */
export function replyThreadingHeaders(message) {
  const id = anchorMessageId(message)
  if (!id) return []
  return [
    { Name: 'In-Reply-To', Value: id },
    { Name: 'References', Value: replyReferences(message) },
  ]
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * "Mon 7 Sep 2026 at 13:34" in Europe/Dublin, the form Gmail writes.
 * Assembled from numeric parts so the month never renders as "Sept" (en-IE
 * and en-GB both do in current ICU) and so the output is the same under any
 * TZ a test runs in.
 */
export function attributionStamp(iso) {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Dublin', weekday: 'short', day: 'numeric', month: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(t))
  const get = (type) => parts.find(p => p.type === type)?.value || ''
  const weekday = get('weekday')
  // `day: 'numeric'` still renders zero-padded under some ICU builds once an
  // hour/minute skeleton is in the same format; Gmail writes "7", not "07".
  const day = String(Number(get('day')) || get('day'))
  const month = MONTHS[Number(get('month')) - 1] || get('month')
  const hour = get('hour') === '24' ? '00' : get('hour')
  return `${weekday} ${day} ${month} ${get('year')} at ${hour}:${get('minute')}`
}

function sameAddress(a, b) {
  return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase() && !!String(a || '').trim()
}

function whoWrote(anchor, { conversation, mailbox }) {
  const from = String(anchor?.from_email || '').trim()
  if (anchor?.direction === 'outbound') {
    if (mailbox?.label && sameAddress(mailbox.address, from)) return `${mailbox.label} <${from}>`
    return from || String(mailbox?.address || '').trim() || 'the studio'
  }
  if (from && conversation?.requester_name && sameAddress(conversation.requester_email, from)) {
    return `${conversation.requester_name} <${from}>`
  }
  return from || 'the sender'
}

/**
 * "On Mon 7 Sep 2026 at 13:34, Richard Ivers <richard@…> wrote:"
 * @param {object} anchor
 * @param {{ conversation: object|null, mailbox: object|null }} ctx
 */
export function attributionLine(anchor, ctx) {
  const stamp = attributionStamp(anchor?.sent_at || anchor?.created_at)
  const who = whoWrote(anchor, ctx || {})
  return stamp ? `On ${stamp}, ${who} wrote:` : `${who} wrote:`
}

/**
 * The anchor's text, bounded (forwardedBody: CRLF-normalised, 20k cap),
 * each line prefixed "> " — so a quoted ">" becomes ">>", the standard cascade.
 * @returns {{ text: string, truncated: boolean }}
 */
export function quotedTextBlock(anchor) {
  const { text, truncated } = forwardedBody(anchor)
  const source = text || NO_TEXT
  const lines = source.split('\n').map(line => (line.startsWith('>') ? `>${line}` : `> ${line}`))
  return { text: lines.join('\n'), truncated }
}

/**
 * The whole text part: signed words, blank line, attribution, quote, and the
 * truncation note (unquoted) when the cap bit. No anchor → the signed text.
 */
export function buildReplyText({ signedText, anchor, conversation, mailbox }) {
  const words = typeof signedText === 'string' ? signedText : ''
  if (!anchor) return words
  const { text, truncated } = quotedTextBlock(anchor)
  const parts = [words.replace(/\s+$/, ''), '', attributionLine(anchor, { conversation, mailbox }), text]
  if (truncated) parts.push('', FORWARD_TRUNCATED_NOTE)
  return parts.join('\n')
}

export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * The HTML part: the caller's body HTML (already escaped text + our own
 * signature block), then the attribution and a cite blockquote of the
 * escaped plain text. type="cite" is what Apple Mail folds; Gmail folds a
 * trailing blockquote it recognises as the previous message.
 */
export function buildReplyHtml({ bodyHtml, anchor, conversation, mailbox }) {
  const body = typeof bodyHtml === 'string' ? bodyHtml : ''
  if (!anchor) return body
  const { text, truncated } = forwardedBody(anchor)
  const quoted = escapeHtml(text || NO_TEXT) + (truncated ? `\n\n${escapeHtml(FORWARD_TRUNCATED_NOTE)}` : '')
  return body
    + `<div style="margin-top:12px;color:#5f6368;font-size:13px">${escapeHtml(attributionLine(anchor, { conversation, mailbox }))}</div>`
    + '<blockquote type="cite" style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex;color:#5f6368">'
    + `<div style="white-space:pre-wrap">${quoted}</div></blockquote>`
}
