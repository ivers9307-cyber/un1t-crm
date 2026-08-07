// EMAIL-CC.1 — the recipient model shared by every ticket send path.
//
// WHY THIS IS A LIB AND NOT INLINE IN THE ROUTES
// Three send paths already exist or are imminent — compose, reply, and the
// forward that lands next — and every one of them has to get the same four
// things right. Duplicated, they drift; drifted, the failure is a
// confidentiality breach rather than a wrong pixel:
//
//   1. WHAT COUNTS AS A RECIPIENT. Validated, normalised, deduped
//      case-insensitively ACROSS To/Cc/Bcc, not merely within each list. The
//      member's own address landing in Cc as well as To is the ordinary
//      version of this bug; the interesting version is an address that differs
//      only in case.
//   2. WHO WE MUST NEVER WRITE TO. Our own mailbox addresses. See EXCLUSIONS.
//   3. THE CAP. An unbounded array on a send path is a spam cannon.
//   4. BCC NEVER LEAVES THE THREAD IT WAS TYPED ON. See the BCC section.
//
// Pure: no DB, no env, no clock. Everything here is a function of its
// arguments, which is what lets the leak-prevention rules be unit-tested
// exhaustively rather than inferred from a route's control flow.
//
// ── BCC ─────────────────────────────────────────────────────────────────
// Bcc is a confidentiality primitive, and it has TWO leak directions.
//
// OUTBOUND (the wire). Bcc addresses are handed to Postmark in its own `Bcc`
// API field and NOWHERE else — never in `Headers`, never folded into `To` or
// `Cc`. Postmark does not put a Bcc header on the delivered message, so no
// recipient sees the list (verified against Postmark's own documentation
// 2026-08-07; their SMTP header change of 2024 says explicitly that Bcc is
// never included in delivered mail, and that API sending was never affected).
// That is the provider's half. OUR half is that nothing in this file or in any
// caller may put a bcc address anywhere a Postmark field other than `Bcc`
// could see it — `toPostmarkFields()` below is the only place the three lists
// are turned into wire values, precisely so that rule has one enforcement site.
//
// INBOUND-TO-US (our own rendering, and the far more likely mistake).
// `email_inbox_messages.bcc_emails` is read by exactly two things: the staff
// thread on a ticket, and nothing else. It is NEVER an input to a later send.
// `threadParticipants()` below — the ONLY function that derives recipients
// from stored correspondence — reads `from_email`, `to_emails` and `cc_emails`
// and does not so much as name `bcc_emails`. So a reply, a reply-all and a
// forward on a ticket that once carried a Bcc all reach the same people they
// would have reached had the Bcc never existed. That is the whole guarantee,
// and `email-recipients.test.js` mutation-checks it.
//
// ── EXCLUSIONS: our own addresses ───────────────────────────────────────
// Every send path passes the studio's own mailbox addresses (plus the Postmark
// From) as `exclude`. This is not tidiness. A reply-all derived from a
// thread necessarily contains the address the member wrote TO — i.e. one of
// ours — and mailing ourselves is not harmless here: Postmark's inbound
// webhook matches the delivered copy's recipient against `email_mailboxes`,
// its In-Reply-To/References still name the thread, so the copy of OUR OWN
// REPLY is filed on the SAME ticket as an INBOUND message. The ticket flips
// back to `open`, `unread_count` increments and the needs-reply badge lights
// up for a message nobody sent us. Not an infinite loop (nothing auto-replies)
// but a queue that lies, forever, once per reply.

import { z } from 'zod'

// The same rule the request schemas apply, so a value that survives validation
// at the edge cannot fail it here (or vice versa). 320 = RFC 5321's 64-char
// local part + '@' + 255-char domain.
const ADDRESS = z.string().email().max(320)

/**
 * The cap, across To + Cc + Bcc COMBINED.
 *
 * Postmark itself allows 50 per field — 150 addresses on one API call — which
 * on a support-ticket reply is a bulk sender wearing a ticket's clothes. A
 * real support thread involves a handful of people; 25 leaves generous room
 * for a genuinely wide internal Cc and still makes the send path useless as a
 * broadcast tool. Enforced SERVER-SIDE in resolveRecipients(); the composer's
 * own limit is an affordance, not the gate.
 */
export const MAX_RECIPIENTS = 25

/**
 * The cap on what we STORE off an inbound email, per list.
 *
 * A stranger can put 500 addresses in a Cc header. Matching Postmark's own
 * per-field maximum keeps one hostile message from turning into an unbounded
 * text[] on a row every ticket read has to pull back. Truncation is silent by
 * design: the message itself is filed in full, and refusing mail over a fat Cc
 * header would be the worse failure.
 */
export const MAX_STORED_RECIPIENTS = 50

/**
 * Lowercased, trimmed address — or null when it is not a valid one.
 *
 * DELIBERATELY STRICTER than normalizeEmail() in email-inbox.js. That one
 * parses hostile inbound headers and must accept whatever a real mail server
 * accepted; this one gates what WE put on the wire, where an unparseable
 * address is an operator typo to reject rather than a fact to record.
 *
 * @param {unknown} addr
 * @returns {string|null}
 */
export function normalizeAddress(addr) {
  if (typeof addr !== 'string') return null
  const trimmed = addr.trim()
  if (!trimmed) return null
  // Accept the "Display Name <addr@example.com>" form operators paste out of
  // their mail client — the angle-bracketed address is the whole value.
  const angled = trimmed.match(/<([^<>]+)>\s*$/)
  const candidate = (angled ? angled[1] : trimmed).trim().toLowerCase()
  return ADDRESS.safeParse(candidate).success ? candidate : null
}

/**
 * Split a list into the addresses we can use and the raw values we cannot.
 *
 * Never throws and never drops silently — the caller decides whether an
 * invalid entry is a refusal (operator input) or debris to skip (a value we
 * stored ourselves months ago).
 *
 * @param {unknown} list
 * @returns {{ valid: string[], invalid: string[] }}
 */
export function normalizeAddressList(list) {
  const valid = []
  const invalid = []
  const seen = new Set()
  for (const raw of Array.isArray(list) ? list : []) {
    const normalized = normalizeAddress(raw)
    if (!normalized) {
      if (raw != null && String(raw).trim()) invalid.push(String(raw).trim())
      continue
    }
    if (seen.has(normalized)) continue
    seen.add(normalized)
    valid.push(normalized)
  }
  return { valid, invalid }
}

/**
 * Addresses out of a Postmark inbound payload pair: the typed `*Full` array
 * ([{ Email, Name }]) and the raw display-string header, in that order.
 *
 * BOTH are read because neither is reliable alone: Postmark omits `CcFull`
 * for some malformed headers and omits `Cc` for others, and a Cc we fail to
 * record is a person the operator never learns was on the thread.
 *
 * Capped at MAX_STORED_RECIPIENTS.
 *
 * @param {unknown} full  Postmark's ToFull / CcFull array
 * @param {unknown} display  Postmark's To / Cc display string
 * @returns {string[]}
 */
export function inboundAddresses(full, display) {
  const out = []
  const seen = new Set()
  const push = (value) => {
    const normalized = normalizeAddress(value)
    if (!normalized || seen.has(normalized)) return
    seen.add(normalized)
    out.push(normalized)
  }
  for (const entry of Array.isArray(full) ? full : []) push(entry?.Email)
  if (typeof display === 'string') for (const part of display.split(',')) push(part)
  return out.slice(0, MAX_STORED_RECIPIENTS)
}

/**
 * Everybody on the thread, as of the message being replied to.
 *
 * THE DEFINITION, stated once so no caller re-derives it: the From, the To and
 * the Cc of the LATEST non-note message on the ticket, minus our own
 * addresses. Nothing else.
 *
 * WHY THE LATEST MESSAGE AND NOT THE UNION OF THE WHOLE THREAD. Mail clients
 * follow the latest message, and so do the people in the conversation. Someone
 * a member deliberately dropped from a later reply has been dropped; silently
 * resurrecting them because they appeared once in March would be its own bug,
 * and a worse one than the omission it "fixes" — it re-copies a person the
 * member chose to exclude, over the member's head.
 *
 * WHY From AND To AND Cc, rather than a direction-specific rule. On an INBOUND
 * message the From is the member and the To holds our mailbox (excluded here);
 * on an OUTBOUND one the From is ours (excluded) and the To/Cc are the people
 * we wrote to. One rule covers both, which is what stops "reply-all on a
 * ticket nobody has answered yet" from being a special case nobody tested.
 *
 * `bcc_emails` IS NOT READ. Not filtered, not read — the field is not named in
 * this function, which is the point. A ticket whose last outbound carried a
 * Bcc must reply-all to exactly the people it would have reached had that Bcc
 * never been typed. See the BCC section in this file's header.
 *
 * @param {object|null} message  an email_inbox_messages row
 * @param {{ exclude?: string[] }} [opts]
 * @returns {string[]}  normalised, deduped, order-stable (From first)
 */
export function threadParticipants(message, { exclude = [] } = {}) {
  if (!message) return []
  const excluded = new Set(normalizeAddressList(exclude).valid)
  const raw = [
    message.from_email,
    ...(Array.isArray(message.to_emails) ? message.to_emails : []),
    // Pre-EMAIL-CC.1 rows have no to_emails array, only the scalar.
    ...(Array.isArray(message.to_emails) && message.to_emails.length ? [] : [message.to_email]),
    ...(Array.isArray(message.cc_emails) ? message.cc_emails : []),
  ]
  return normalizeAddressList(raw).valid.filter(a => !excluded.has(a))
}

/**
 * The newest message a reply is actually answering.
 *
 * Internal notes are skipped: a note was sent to nobody, so it names no
 * participants and cannot be the thing being replied to.
 *
 * @param {object[]} messages  any order
 * @returns {object|null}
 */
export function latestCorrespondence(messages) {
  const real = (Array.isArray(messages) ? messages : []).filter(m => m && !m.is_internal_note)
  if (real.length === 0) return null
  return real.reduce((newest, m) => {
    const a = Date.parse(m.created_at || m.sent_at || 0) || 0
    const b = Date.parse(newest.created_at || newest.sent_at || 0) || 0
    return a > b ? m : newest
  })
}

/**
 * 'reply' for a one-person thread, 'reply_all' for anything wider.
 *
 * THE MODE IS DERIVED, NEVER CHOSEN (Richard, 2026-08-07). There is one send
 * button and its label states who it reaches — "Reply All (4 people)" stops a
 * mistake that a bare "Reply" on a four-person thread causes. Offering both on
 * a multi-party thread is exactly the affordance that lets someone silently
 * drop a participant by clicking the wrong one, so it is not offered.
 *
 * @param {string[]} recipients  the resolved To set
 * @returns {'reply'|'reply_all'}
 */
export function replyMode(recipients) {
  return (Array.isArray(recipients) ? recipients : []).length > 1 ? 'reply_all' : 'reply'
}

/** How many addresses a resolved set actually writes to. */
export function recipientCount({ to = [], cc = [], bcc = [] } = {}) {
  return to.length + cc.length + bcc.length
}

/**
 * Validate, normalise, dedupe, exclude and cap — the one gate every send path
 * runs its recipients through.
 *
 * PRECEDENCE IS To > Cc > Bcc, and it is what stops the member's own address
 * appearing twice. An address in To is removed from Cc and Bcc; an address in
 * Cc is removed from Bcc. The strongest visibility wins, always: silently
 * demoting someone from To to Bcc would change who the other recipients think
 * the mail was addressed to.
 *
 * REFUSES rather than repairs on invalid input. A typo'd address is an
 * operator error to show them, not something to drop on their behalf — they
 * would never learn the person was left off. Callers that derive addresses
 * from data WE stored pre-filter with normalizeAddressList().valid instead,
 * because a malformed row from months ago is our problem and must not stop
 * someone answering a member.
 *
 * @param {object} args
 * @param {string[]} [args.to]
 * @param {string[]} [args.cc]
 * @param {string[]} [args.bcc]
 * @param {string[]} [args.exclude]  our own addresses — removed from ALL THREE
 * @returns {{ ok: true, to: string[], cc: string[], bcc: string[], count: number }
 *          | { ok: false, code: string, error: string, invalid?: string[] }}
 */
export function resolveRecipients({ to = [], cc = [], bcc = [], exclude = [] } = {}) {
  const lists = {
    to: normalizeAddressList(to),
    cc: normalizeAddressList(cc),
    bcc: normalizeAddressList(bcc),
  }

  const invalid = [...lists.to.invalid, ...lists.cc.invalid, ...lists.bcc.invalid]
  if (invalid.length) {
    return {
      ok: false,
      code: 'invalid_address',
      error: `Not a valid email address: ${invalid.slice(0, 5).join(', ')}`,
      invalid,
    }
  }

  const excluded = new Set(normalizeAddressList(exclude).valid)
  const claimed = new Set()
  const take = (list) => {
    const out = []
    for (const address of list) {
      // Our own addresses go first — an operator who typed one is corrected
      // rather than refused, because the correct outcome (do not mail
      // ourselves) is unambiguous and refusing would strand a real reply.
      if (excluded.has(address)) continue
      if (claimed.has(address)) continue
      claimed.add(address)
      out.push(address)
    }
    return out
  }

  const resolvedTo = take(lists.to.valid)
  const resolvedCc = take(lists.cc.valid)
  const resolvedBcc = take(lists.bcc.valid)

  if (resolvedTo.length === 0) {
    return {
      ok: false,
      code: 'no_recipients',
      error: 'No recipient address for this message.',
    }
  }

  const count = resolvedTo.length + resolvedCc.length + resolvedBcc.length
  if (count > MAX_RECIPIENTS) {
    return {
      ok: false,
      code: 'too_many_recipients',
      error: `Too many recipients — ${count} addresses across To, Cc and Bcc. The limit is ${MAX_RECIPIENTS}.`,
    }
  }

  return { ok: true, to: resolvedTo, cc: resolvedCc, bcc: resolvedBcc, count }
}

/**
 * The ONLY place a resolved recipient set becomes Postmark wire values.
 *
 * Bcc appears in `Bcc` and nowhere else — that single-site rule is what makes
 * the outbound half of the confidentiality guarantee auditable. Empty lists
 * collapse to `undefined` so sendEmail's request body is byte-identical to a
 * pre-EMAIL-CC.1 send for every caller that passes no cc/bcc.
 *
 * @param {{ to: string[], cc?: string[], bcc?: string[] }} recipients
 * @returns {{ to: string, cc: string|undefined, bcc: string|undefined }}
 */
export function toPostmarkFields({ to = [], cc = [], bcc = [] } = {}) {
  const join = (list) => (list.length ? list.join(', ') : undefined)
  return { to: to.join(', '), cc: join(cc), bcc: join(bcc) }
}

/**
 * The addresses this send reaches that were NOT already on the thread.
 *
 * Compose and a manually-added Cc/Bcc are a DIFFERENT ACT from replying to
 * someone who wrote to us: the member never involved these people. There is no
 * consent gate on ticket mail by design (the member wrote first, and swallowing
 * the answer to their own question is worse), and that reasoning does not
 * stretch to a stranger — so instead of a gate the act is made attributable.
 * Routes feed this to logAuditEvent() so every address a staff member added by
 * hand carries their name, at the time they added it.
 *
 * @param {{ to?: string[], cc?: string[], bcc?: string[] }} resolved
 * @param {string[]} known  addresses already on the thread
 * @returns {string[]}
 */
export function newRecipients({ to = [], cc = [], bcc = [] } = {}, known = []) {
  const already = new Set(normalizeAddressList(known).valid)
  return [...to, ...cc, ...bcc].filter(a => !already.has(a))
}
