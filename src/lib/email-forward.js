// EMAIL-FORWARD.1 — the pure rules for forwarding one message off a ticket:
// the subject, the quoted header block, the body, and which of the original's
// files may ride along.
//
// Pure: no DB, no Storage, no env, no clock (every timestamp is an argument).
// The IO lives in src/lib/email-forward-server.js and the route decides
// nothing. Same split as email-recipients.js / email-outbound-attachments.js,
// and for the same reason: the two rules that must not go wrong here are
// negative space, and negative space is only testable when it is a function.
//
// ══ THE TWO RULES ═══════════════════════════════════════════════════
//
// 1. BCC NEVER LEAVES THE THREAD IT WAS TYPED ON — and a forward has TWO ways
//    to break that, not one.
//
//    (a) AS A RECIPIENT. Handled where it always was: the route derives no
//        recipients from stored correspondence at all (a forward's addresses
//        are typed by the operator, like a compose), and the SELECT it reads
//        the source message with does not name `bcc_emails`. Nothing in this
//        file produces a recipient.
//
//    (b) IN THE QUOTED BODY, which is new and is the more natural mistake. A
//        forward reproduces the original's headers, and "reproduce the
//        headers" is one careless spread away from printing the Bcc list into
//        an email addressed to someone who was never on the thread. So
//        forwardedHeaderLines() below is an EXPLICIT, CLOSED list of five
//        headers — From, Date, Subject, To, Cc — and the string `bcc` does not
//        appear in it. email-forward.test.js mutation-checks that: every
//        fixture carries bcc addresses and every assertion is on their
//        ABSENCE from the produced text.
//
// 2. A STRANGER'S HTML NEVER GOES OUT AS MARKUP. See FORWARDING IS PLAIN TEXT.
//
// ══ FORWARDING IS PLAIN TEXT, DELIBERATELY ══════════════════════════
// The obvious implementation quotes the sanitised `html_document` the thread
// already renders. It is the wrong one, for three reasons that stack:
//
//   • THE SANITISER'S PERMISSIVENESS IS BOUGHT BY THE IFRAME. email-html.js
//     says so in its own header: it is "permissive on presentation, strict on
//     execution" precisely BECAUSE layer 1 (a sandbox with neither
//     allow-scripts nor allow-same-origin) contains whatever it lets through.
//     Putting that output on the wire deletes layer 1 and keeps the
//     permissiveness — <style> blocks, `allowVulnerableTags: true`, inline CSS
//     from an unauthenticated stranger — in a document rendered by a mail
//     client we do not control.
//   • IT WOULD PUT OUR DKIM SIGNATURE ON A STRANGER'S MARKUP. A forward leaves
//     from the studio's own verified sending domain. Forwarding a phishing
//     email as HTML hands the phish an authenticated envelope and our sender
//     reputation; the colleague receives it looking exactly like mail from
//     accounts@. That is the classic way forwarding launders a phish, and it
//     is not a risk worth a nicer-looking quote.
//   • THE SANITISED DOCUMENT IS NOT MAIL. Its images are PARKED, not loaded —
//     `data-original-src` and the `x-un1t-blocked:` scheme — so the recipient
//     would get a body full of dead placeholders and an unresolvable URL
//     scheme. It is a render for a specific frame, not a portable document.
//
// So the quote is `text_body` — which every inbound message has, because the
// webhook stores `TextBody || htmlToPlainText(HtmlBody)` — and the outbound
// HtmlBody is that same text run through the SAME escape-and-wrap the reply
// and compose routes use. No byte of a stranger's markup is ever emitted as
// markup: it is escaped into text before it reaches the wire, which is a
// stronger guarantee than sanitisation rather than a weaker one.
//
// The operator is told, in the composer and in the mail itself, that
// formatting was dropped. The full original stays on the ticket.

import { formatBytes } from './email-attachment-quota'
import {
  MAX_OUTBOUND_ATTACHMENT_TOTAL_BYTES,
  exceedsOutboundTotal,
} from './email-outbound-attachments'

/**
 * How much of the original body is quoted.
 *
 * Bounded rather than unbounded because the quote shares one Postmark message
 * with up to 7 MiB of attachments. MAX_OUTBOUND_ATTACHMENT_TOTAL_BYTES leaves
 * 213,288 bytes of the 10 MB ceiling for everything else; 20,000 characters of
 * quote plus its escaped HTML twin is ~40 KB of that, alongside the operator's
 * own 10,000-character note and a 2,000-character signature. Three times the
 * headroom needed, and twice what an operator may type themselves.
 *
 * Truncation is VISIBLE (see FORWARD_TRUNCATED_NOTE) — the recipient is told
 * the message was longer, because a quote that stops mid-sentence with no
 * marker reads as the whole of what arrived.
 */
export const FORWARD_QUOTE_MAX_CHARS = 20_000

/** Said in the forwarded mail itself, where the text stops. */
export const FORWARD_TRUNCATED_NOTE =
  '[This message was longer than we forward in full. Ask the sender for the rest if you need it.]'

/**
 * Said in the forwarded mail when the original was formatted HTML.
 *
 * Deliberately plain and non-alarming: nothing went wrong, we simply do not
 * re-send other people's markup. See FORWARDING IS PLAIN TEXT above.
 */
export const FORWARD_PLAIN_TEXT_NOTE =
  '[Forwarded as plain text — the original formatting and any embedded images are not included.]'

/** The line that opens the quoted block, so a reader knows where our words end. */
export const FORWARD_SEPARATOR = '---------- Forwarded message ----------'

/**
 * "Fwd: " exactly once.
 *
 * Every prefix a real mail client emits is treated as already-forwarded —
 * `Fwd:`, `FW:`, `Fw:` — so forwarding a forward does not stack them. A `Re:`
 * is NOT stripped: "Fwd: Re: Refund" is the truthful description of forwarding
 * a reply, and rewriting someone else's subject line loses the thread they
 * recognise.
 */
export function forwardSubject(subject) {
  const s = String(subject || '').trim()
  if (!s) return 'Fwd: (no subject)'
  return /^\s*(fwd?|fw)\s*:/i.test(s) ? s : `Fwd: ${s}`
}

/**
 * A timestamp for the quoted header block.
 *
 * EXPLICIT timeZone, always. A bare toLocaleString() would render the studio's
 * correspondence in whatever zone the Vercel region happens to run in (UTC),
 * so a 9am email would be forwarded as having arrived at 8am all summer. The
 * `en-IE` locale + Europe/Dublin pair is the estate's convention, and stating
 * the zone also makes this deterministic under any TZ a test runs in.
 *
 * @param {string|null} iso
 * @returns {string} '' when there is no usable timestamp — the line is then
 *   omitted entirely rather than rendered as "Date: Invalid Date".
 */
export function forwardTimestamp(iso) {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  return new Intl.DateTimeFormat('en-IE', {
    timeZone: 'Europe/Dublin',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(t))
}

/**
 * THE HEADERS A FORWARD REPRODUCES. A CLOSED LIST OF FIVE.
 *
 * From, Date, Subject, To, Cc — the block every mail client writes, and
 * NOTHING ELSE. `bcc_emails` is not read, not filtered and not named: the
 * word does not appear in this function, which is the property the tests
 * assert rather than the behaviour.
 *
 * WHY BCC IS ABSENT RATHER THAN REDACTED. A "Bcc: (hidden)" line would still
 * tell the forward's recipient that somebody was blind-copied, which is
 * exactly the fact a Bcc exists to keep. The header block must read as though
 * the Bcc was never typed — the same guarantee ticketParticipants() gives on
 * the recipient side (src/lib/email-recipients.js), by the same means: the
 * column is not named.
 *
 * Empty values are omitted rather than rendered blank: "To:" with nothing
 * after it reads as a message sent to nobody.
 *
 * @param {object|null} message  an email_inbox_messages row
 * @returns {{ label: string, value: string }[]} in header order
 */
export function forwardedHeaderLines(message) {
  if (!message) return []
  const list = (v) => (Array.isArray(v) ? v.filter(a => typeof a === 'string' && a.trim()) : [])
  // Pre-mig-499 rows carry only the scalar to_email.
  const to = list(message.to_emails).length
    ? list(message.to_emails)
    : (message.to_email ? [message.to_email] : [])

  const lines = []
  const push = (label, value) => {
    const v = String(value || '').trim()
    if (v) lines.push({ label, value: v })
  }
  push('From', message.from_email)
  push('Date', forwardTimestamp(message.sent_at || message.created_at))
  push('Subject', message.subject)
  push('To', to.join(', '))
  push('Cc', list(message.cc_emails).join(', '))
  return lines
}

/**
 * The original's body, as plain text, bounded.
 *
 * `text_body` is the only body a forward ever quotes. The webhook already
 * stores `TextBody || htmlToPlainText(HtmlBody)` for every inbound message, so
 * this is the sender's own plain-text alternative when they sent one and a
 * conservative conversion when they did not — either way it is text, and the
 * caller escapes it before it becomes HTML.
 *
 * `hadHtml` only decides whether the "forwarded as plain text" note is worth
 * saying. It is never a route to the HTML itself.
 *
 * @param {object|null} message
 * @returns {{ text: string, truncated: boolean }}
 */
export function forwardedBody(message) {
  const raw = String(message?.text_body || '').replace(/\r\n/g, '\n').trim()
  if (raw.length <= FORWARD_QUOTE_MAX_CHARS) return { text: raw, truncated: false }
  return { text: raw.slice(0, FORWARD_QUOTE_MAX_CHARS).trimEnd(), truncated: true }
}

/**
 * The whole plain-text body of the forward: the operator's note, then the
 * separator, then the closed header block, then the original's text.
 *
 * The operator's note comes FIRST and the quote second, which is the order
 * every mail client uses and the order a reader needs — "why am I being sent
 * this" before "here is the thing".
 *
 * @param {object} args
 * @param {string} args.note      what the operator typed (may be empty)
 * @param {object} args.message   the message being forwarded
 * @returns {string}
 */
export function buildForwardText({ note, message } = {}) {
  const { text, truncated } = forwardedBody(message)
  const headers = forwardedHeaderLines(message).map(l => `${l.label}: ${l.value}`)

  const parts = []
  const intro = String(note || '').trim()
  if (intro) parts.push(intro, '')
  parts.push(FORWARD_SEPARATOR)
  if (headers.length) parts.push(...headers)
  // The note about formatting sits with the headers, not with our own words:
  // it describes the quoted message, and an operator's note that ends in a
  // parenthetical about HTML reads as something they wrote.
  if (message?.html_body) parts.push(FORWARD_PLAIN_TEXT_NOTE)
  parts.push('')
  parts.push(text || '(no text content)')
  if (truncated) parts.push('', FORWARD_TRUNCATED_NOTE)
  return parts.join('\n')
}

// ── Which files ride along ──────────────────────────────────────────
//
// THE GOVERNING RULE IS THE OUTBOUND ONE, UNCHANGED: the thread never claims a
// file went out that did not. Everything below runs BEFORE the send, and every
// refusal it produces is a refusal to send at all.

/**
 * The attachments of the original that COULD be forwarded.
 *
 * A row with no bytes — over quota on arrival, over the per-file ceiling, or
 * pruned to free space — is still rendered in the thread (that is the whole
 * point of keeping the row), but it must never be offered as forwardable:
 * there is nothing to attach, and a checkbox for it would promise a file that
 * cannot be sent.
 *
 * TWO SHAPES, ONE QUESTION. The server sees the row and asks `storage_path`;
 * the browser sees what the ticket detail route chose to expose and asks
 * `stored`, because that route deliberately never returns storage_path to a
 * client (the bucket is private and the path is signed server-side only). They
 * are the same fact — the route computes `stored: !!row.storage_path` — so
 * this accepts either rather than forcing the composer to re-express the rule
 * in its own vocabulary, which is how the two would drift.
 *
 * @param {object[]} rows  attachment rows, in either shape
 * @returns {object[]}
 */
export function forwardableAttachments(rows) {
  return (Array.isArray(rows) ? rows : []).filter(r => r && (r.storage_path || r.stored))
}

/** The sum of the stored sizes of a chosen set — the COMPOSER'S estimate. */
export function forwardBudget(rows) {
  const used = (Array.isArray(rows) ? rows : [])
    .reduce((sum, r) => sum + (Number(r?.size_bytes) || 0), 0)
  return {
    used,
    limit: MAX_OUTBOUND_ATTACHMENT_TOTAL_BYTES,
    remaining: Math.max(0, MAX_OUTBOUND_ATTACHMENT_TOTAL_BYTES - used),
    over: exceedsOutboundTotal(used),
  }
}

/**
 * Resolve the ids an operator chose against the message's own attachments.
 *
 * REFUSES rather than repairs, in both directions:
 *   • an id that is not on this message — the client asked for a file that is
 *     not part of what it is forwarding, which is either a bug or a probe.
 *     Dropping it silently would send a forward missing a file the operator
 *     ticked.
 *   • an id whose bytes were never stored — the same, with a sentence that
 *     names the file, because the operator can act on that one (ask for a
 *     resend).
 *
 * Order follows the ORIGINAL's attachment order, not the order the ids
 * arrived in, so the forwarded message's chips read the same way round as the
 * message it came from.
 *
 * @param {object[]} rows  every attachment row of the source message
 * @param {string[]} ids   what the operator chose
 * @returns {{ ok: true, rows: object[] } | { ok: false, error: string }}
 */
export function selectForwardAttachments(rows, ids) {
  const chosen = Array.isArray(ids) ? ids.filter(Boolean) : []
  if (chosen.length === 0) return { ok: true, rows: [] }

  const unique = [...new Set(chosen.map(String))]
  const byId = new Map((Array.isArray(rows) ? rows : []).filter(r => r?.id).map(r => [String(r.id), r]))

  for (const id of unique) {
    const row = byId.get(id)
    if (!row) {
      return {
        ok: false,
        error: 'One of the files you chose is not on that message any more. Reopen the ticket and try again — nothing was sent.',
      }
    }
    if (!row.storage_path) {
      return {
        ok: false,
        error: `“${row.filename || 'That file'}” was never stored, so there is nothing to forward. ` +
          'Untick it and try again — nothing was sent.',
      }
    }
  }

  const wanted = new Set(unique)
  return { ok: true, rows: (rows || []).filter(r => wanted.has(String(r?.id))) }
}

/**
 * What an operator reads when the chosen files do not fit in one email.
 *
 * THE DECISION (Richard's brief, EMAIL-FORWARD.1): the operator CHOOSES, and
 * nothing is dropped for them. An inbound email can legitimately carry more
 * than Postmark will let us forward — 25 MB arrives inbound, 7 MiB of raw
 * bytes leaves — so "forward everything" is not always available. The composer
 * therefore lists every forwardable file with a checkbox and a running total,
 * pre-ticked when the whole set fits and pre-ticked to NOTHING when it does
 * not, and the server refuses an over-budget set outright.
 *
 * Pre-ticking nothing rather than a greedy subset is deliberate: a subset we
 * chose is a set of files the operator did not decide to leave out, which is
 * the silent drop this whole feature is built to avoid. Naming the numbers is
 * what makes the decision theirs.
 *
 * Distinct from outboundSizeError() next door because the remedy is different:
 * there the answer is "remove a file you attached", here it is "untick one, or
 * send them across two forwards".
 */
export function forwardSizeError(totalBytes) {
  return `Those files come to ${formatBytes(totalBytes)}. One email can carry ` +
    `${formatBytes(MAX_OUTBOUND_ATTACHMENT_TOTAL_BYTES)} of attachments in total ` +
    '(the mail provider\'s ceiling). Nothing was sent — untick one and try again, ' +
    'or forward them across two emails.'
}

/**
 * The composer's default selection.
 *
 * Everything, when everything fits. Nothing, when it does not — see
 * forwardSizeError() for why a greedy subset is the wrong default.
 *
 * @param {object[]} rows  already filtered by forwardableAttachments()
 * @returns {string[]} attachment ids
 */
export function defaultForwardSelection(rows) {
  const list = Array.isArray(rows) ? rows : []
  if (list.length === 0) return []
  return forwardBudget(list).over ? [] : list.map(r => r.id)
}

/**
 * Can this message be forwarded as mail at all?
 *
 * INTERNAL NOTES CANNOT. A note is staff-to-staff text that was never sent to
 * anybody: it has no From, no recipients and no envelope, and its content is
 * written on the assumption that only colleagues read it. Forwarding one would
 * take internal commentary about a member and mail it to a third party under
 * the studio's own address — the single worst thing this surface could do, and
 * the reason it is refused in the route as well as hidden in the thread.
 *
 * @param {object|null} message
 * @returns {null|string} null when it may be forwarded, else the refusal
 */
export function forwardRefusal(message) {
  if (!message) {
    return 'That message is not on this ticket.'
  }
  if (message.is_internal_note) {
    return 'An internal note was never sent to anyone and is staff-only, so it cannot be forwarded. ' +
      'Copy anything the recipient needs into the forward instead.'
  }
  return null
}
