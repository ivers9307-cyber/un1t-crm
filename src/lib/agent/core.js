// RADAR-AGENT.0 — pure runtime helpers for the customer agent.
//
// All functions here are pure (no DB, no network) so they can be
// unit-tested under the Node env. The IO orchestration lives in
// auto-reply.js; the webhook owns the trigger.

import { HANDOFF_PREFIX, OPTIONS_PREFIX, SKIP_PREFIX } from './prompt'

export const AGENT_MESSAGE_SOURCE = 'agent'
export const DEFAULT_HOLDING_MESSAGE =
  "Thanks for your message! One of the UN1T team will get back to you shortly."

// MIA-CREDITS.1 — sent (verbatim, operator-editable via
// settings.no_credits_handoff_text) when a booking pre-flight finds no
// usable balance and the thread hands off to a human. Wording is Richard's
// (2026-08-25): state the situation honestly, promise a person, no options
// menu a warm customer could bounce off.
export const DEFAULT_NO_CREDITS_HANDOFF_TEXT =
  "You're out of class credits at the moment so I can't book that one straight away. I'll escalate this to a team member to help you out now."

/** Normalise a phone to digits only (drops +, spaces, dashes). */
export function normalisePhone(p) {
  return String(p || '').replace(/[^\d]/g, '')
}

/**
 * True if senderPhone matches any entry in the allow-list. Compares the
 * last 9 digits (the national significant number) so +353/353/0-trunk
 * variants of the same Irish number all match, while still requiring a
 * real match for short/foreign numbers.
 */
export function phoneMatchesAllowlist(senderPhone, list) {
  const s = normalisePhone(senderPhone)
  if (!s) return false
  const sTail = s.slice(-9)
  return (list || []).some(entry => {
    const e = normalisePhone(entry)
    if (!e) return false
    if (e === s) return true
    return e.length >= 9 && s.length >= 9 && e.slice(-9) === sTail
  })
}

/**
 * Minutes-of-day (0-1439) for `date` in the given IANA timezone.
 * Uses Intl (available in Node) so we don't pull a tz library.
 */
export function minutesOfDayInTz(date, tz) {
  try {
    const fmt = new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz || 'UTC',
    })
    const parts = fmt.formatToParts(date)
    const h = Number(parts.find(p => p.type === 'hour')?.value)
    const m = Number(parts.find(p => p.type === 'minute')?.value)
    if (Number.isNaN(h) || Number.isNaN(m)) return null
    return (h % 24) * 60 + m
  } catch {
    return null
  }
}

function parseHHMM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim())
  if (!m) return null
  const h = Number(m[1]); const min = Number(m[2])
  if (h > 23 || min > 59) return null
  return h * 60 + min
}

/**
 * Is `now` within the configured quiet-hours window? Handles overnight
 * ranges (e.g. 21:00 → 07:00). Returns false if config is incomplete.
 * @param {Date} now
 * @param {{start?:string,end?:string,tz?:string}|null} quiet
 */
export function isWithinQuietHours(now, quiet) {
  if (!quiet || !quiet.start || !quiet.end) return false
  const start = parseHHMM(quiet.start)
  const end = parseHHMM(quiet.end)
  if (start == null || end == null || start === end) return false
  const cur = minutesOfDayInTz(now, quiet.tz || 'Europe/Dublin')
  if (cur == null) return false
  if (start < end) return cur >= start && cur < end      // same-day window
  return cur >= start || cur < end                        // overnight wrap
}

/**
 * Decide whether the agent should auto-reply to an inbound message.
 * Pure — all state is passed in. Returns { reply, reason }.
 *
 * @param {object} args
 * @param {object|null} args.settings      locations.settings.customer_agent
 * @param {object|null} args.conversation  { agent_active }
 * @param {object}      args.message       { type, body }
 * @param {string}      args.senderPhone
 * @param {Date}        [args.now]
 */
// AGENT-REARM.1 — default hours before a handed-off thread auto-releases
// back to the agent when nobody resolved it. 0/null = never.
export const DEFAULT_HANDOFF_COOLDOWN_HOURS = 12

/**
 * Has a handoff outlived the cooldown? No timestamp (a manual agent-off)
 * or no/zero cooldown means never. Pure.
 */
export function isHandoffExpired(handedOffAt, cooldownHours, now = new Date()) {
  if (!handedOffAt) return false
  const hours = Number(cooldownHours)
  if (!Number.isFinite(hours) || hours <= 0) return false
  const t = new Date(handedOffAt).getTime()
  if (!Number.isFinite(t)) return false
  return now.getTime() - t >= hours * 60 * 60 * 1000
}

/**
 * Extra conversation-update fields when an operator resolves a thread:
 * resolving a handed-off conversation hands it straight back to the
 * agent ("human engagement closed"). Pure — used by the WA + IG
 * conversation PATCH routes.
 */
export function resolveRearmPatch({ resolved, agent_handed_off_at } = {}) {
  if (resolved === true && agent_handed_off_at) {
    // MIA-REVIEW.3 — clear the SLA escalation stamp too. It was written by the
    // handoff-SLA sweep and cleared nowhere, so after one escalation the thread
    // could never escalate again for the rest of its life (conversations are
    // one per contact per channel). The handoff is over; re-arm the safety net.
    return { agent_active: true, agent_handed_off_at: null, handoff_escalated_at: null }
  }
  return {}
}

/**
 * Conversation-patch when an operator sends a MANUAL message: that's an
 * intentional human take-over, so the auto-responder must stop replying in
 * this thread (shouldAgentReply skips when agent_active === false). Stamps a
 * handoff timestamp so it can AUTO-RE-ARM after handoff_cooldown_hours of
 * quiet (and resolving the thread re-arms instantly).
 *
 * AGENT-REARM.2 — the stamp REFRESHES on every manual send, so the cooldown
 * measures from the human's LAST message, not their first. The original
 * preserve-the-stamp behaviour meant a multi-day human-led exchange kept a
 * stale stamp, the 12h cooldown expired mid-conversation, and Mia answered a
 * customer who was replying to Richard (Kevin, 2026-07-03). Belt-and-braces
 * with the human-owned gate in shouldAgentReply. Pure — used by the WhatsApp
 * + Instagram operator send routes. (A null stamp would mean a PERMANENT
 * off, which we deliberately avoid here.)
 */
export function manualTakeoverPatch(_existingHandoffAt, now = new Date()) {
  return {
    agent_active: false,
    agent_handed_off_at: now.toISOString(),
  }
}

// AGENT-BOTLOOP.1 — recognise a business auto-responder so Mia doesn't
// introduce herself to an answering machine (live cases 2026-06-29: Zen
// Movement's "we may be teaching…" and PD Aesthetic's "Welcome to…" both
// replied within seconds of our template and got a warm Mia intro back).
// Deliberately conservative: needs TWO independent signals (or one
// explicit "automated message/reply" marker) plus some length, so a real
// person writing "thanks for your message!" is never silenced.
const AUTO_REPLY_EXPLICIT = /\bauto[- ]?(?:reply|response|responder)\b|\bautomated (?:message|response|reply)\b/i
const AUTO_REPLY_SIGNALS = [
  /\bthank(?:s| you) for (?:contacting|your message|reaching out|getting in touch)\b/i,
  /\bwe(?:'|’)?(?:ll| will) (?:get back to you|be in touch|respond|reply)\b/i,
  /\bI(?:'|’)?ll get back to you\b/i,
  /\bas soon as (?:we|I) can\b|\bas soon as possible\b/i,
  /\bwelcome to\b[^.\n]{0,60}(?:clinic|studio|salon|gym|spa|centre|center)\b/i,
  /\bunable to (?:answer|respond|take your)\b|\bmay be (?:teaching|with a client|closed)\b/i,
  /\bbook(?:ings?)? (?:can be made|directly|online)\b[^.\n]{0,60}\blinks?\b/i,
  /\bout of (?:the )?office\b|\bcurrently closed\b|\bopening hours\b/i,
]

/** Does this inbound text read like a business auto-responder? Pure. */
export function isLikelyBusinessAutoReply(body) {
  const text = String(body || '').trim()
  if (text.length < 60) return false
  if (AUTO_REPLY_EXPLICIT.test(text)) return true
  let hits = 0
  for (const re of AUTO_REPLY_SIGNALS) {
    if (re.test(text)) hits++
    if (hits >= 2) return true
  }
  return false
}

/**
 * The enabled/test_mode combine, in ONE place so shouldAgentReply and
 * shouldSendWelcome can't drift. Semantics are the documented invariant and
 * do NOT change here: `enabled=true` + `test_mode=true` is LIVE FOR EVERYONE
 * (the allowlist only scopes an agent that is NOT enabled). Pure.
 */
export function resolveAgentGate(settings) {
  const s = settings || {}
  const enabled = !!s.enabled
  const testMode = !!s.test_mode
  return {
    enabled,
    testMode,
    off: !enabled && !testMode,
    allowlistScoped: !enabled && testMode,
    liveDespiteTestMode: enabled && testMode,
  }
}

// One tripwire log per (process, location) — a warn per turn would drown the
// live path in a state that is, by design, allowed to persist.
const LIVE_TEST_MODE_WARNED = new Set()

/**
 * Tripwire for the operator foot-gun: an agent saved as enabled AND test_mode
 * answers EVERY customer, not just the allowlist. Behaviour is unchanged (the
 * invariant is deliberate) — this just makes the state greppable in logs the
 * first time a location hits it. Returns whether the state is live-despite-test.
 */
export function warnLiveDespiteTestMode(locationId, settings) {
  if (!resolveAgentGate(settings).liveDespiteTestMode) return false
  const key = String(locationId || 'unknown')
  if (!LIVE_TEST_MODE_WARNED.has(key)) {
    LIVE_TEST_MODE_WARNED.add(key)
    console.error('[radar-agent] live_despite_test_mode', JSON.stringify({
      locationId: key,
      detail: 'customer_agent is enabled AND test_mode — the test allowlist is NOT in effect; the agent replies to every customer.',
    }))
  }
  return true
}

// Message types that are content-bearing enough to be worth acknowledging with
// the soft handoff. A REACTION is not a message needing an answer — a 👍 on
// Mia's confirmation used to earn the customer a holding message and managers
// a "sent a photo / voice / attachment" page.
const IGNORABLE_MESSAGE_TYPES = new Set(['reaction'])

export function shouldAgentReply({ settings, conversation, message, senderPhone, lastOutboundHuman = false, now = new Date() }) {
  const s = settings || {}
  const { enabled, testMode } = resolveAgentGate(s)
  if (!enabled && !testMode) return { reply: false, reason: 'disabled' }

  // INBOX-REDESIGN.2.3 — sticky operator pause (mig 435: whatsapp_conversations
  // .agent_paused_at). Checked before the kill switch and content gates so a
  // paused thread stays FULLY silent: no onDuty, no soft-handoff acknowledgement,
  // no re-arm. Cleared only by the explicit resume endpoint.
  if (conversation?.agent_paused_at) return { reply: false, reason: 'agent_paused' }

  // Per-conversation kill switch (human takeover / prior escalation).
  // AGENT-REARM.1 — a handoff auto-releases after the configured
  // cooldown so one escalation doesn't silence the agent forever; the
  // rearm flag tells the caller to clear the handoff stamp in the DB.
  // A manual agent-off (no handoff timestamp) never auto-releases.
  // AGENT-REARM.2 — but a thread whose LAST outbound message was sent by
  // a HUMAN is that human's conversation, cooldown or not: the customer
  // is replying to THEM. Never re-arm into it (Mia hijacked Kevin's
  // reply to Richard this way, 2026-07-03) — the inbound push + inbox
  // queue alert the team; only a resolve (or Mia's own holding message
  // being the last word) hands the thread back.
  let rearm = false
  if (conversation && conversation.agent_active === false) {
    const cooldown = s.handoff_cooldown_hours ?? DEFAULT_HANDOFF_COOLDOWN_HOURS
    if (!isHandoffExpired(conversation.agent_handed_off_at, cooldown, now)) {
      return { reply: false, reason: 'handed_off' }
    }
    if (lastOutboundHuman) {
      return { reply: false, reason: 'human_owned' }
    }
    rearm = true
  }

  // Test mode (not globally enabled): only reply to allow-listed numbers.
  if (!enabled && testMode) {
    if (!phoneMatchesAllowlist(senderPhone, s.test_phones)) {
      return { reply: false, reason: 'not_in_test_allowlist' }
    }
  }

  if (isWithinQuietHours(now, s.quiet_hours)) {
    return { reply: false, reason: 'quiet_hours' }
  }

  // The agent is on duty from here. Content gates carry onDuty:true so the
  // caller can ACKNOWLEDGE a non-text message (soft handoff → a human)
  // instead of silently dropping it. (Checked after the on-duty gates so
  // we never acknowledge while disabled, off-allowlist, or in quiet hours.)
  // 'interactive' = a tapped quick-reply/list button; the webhook maps the
  // tap to its title in body, so it's a text reply in all but name.
  // Voice notes (Richard's call, 2026-06-12): no transcription vendor —
  // audio takes the soft-handoff path below, so Mia acknowledges the
  // voice note and the thread lands in the team's review queue.
  const type = message?.type || 'text'
  // MIA-REVIEW.2 — a tapped reaction is a no-op, not an unreadable message:
  // stay fully silent (no holding message, no manager page).
  if (IGNORABLE_MESSAGE_TYPES.has(type)) {
    return { reply: false, reason: 'ignorable_type' }
  }
  if (type !== 'text' && type !== 'interactive') {
    return { reply: false, reason: 'unsupported_type', onDuty: true }
  }
  if (!String(message?.body || '').trim()) return { reply: false, reason: 'empty', onDuty: true }

  // AGENT-BOTLOOP.1 — a business auto-responder answered our outreach.
  // Stay silent (no reply, no soft handoff): replying re-triggers THEIR
  // bot, and there is no human on the other end to hand off to yet. A
  // real human's follow-up text won't match and re-engages normally.
  if (type === 'text' && isLikelyBusinessAutoReply(message?.body)) {
    return { reply: false, reason: 'auto_reply' }
  }

  const ok = { reply: true, reason: 'ok' }
  if (rearm) ok.rearm = true
  return ok
}

// HARDEN.2 — anti-spoofing for inbound customer text. Two markers carry
// authority in this protocol and a customer can type both: the
// "[STUDIO SYSTEM …]" prefix the proactive paths use to address the model
// (followups.js / approval-suggest.js inject it as a user-role turn), and the
// [[HANDOFF]] / [[OPTIONS]] / [[SKIP]] control sentinels. Neutralise them on
// the way in so only the studio can ever issue one — the prompt's
// untrusted-input rule is the second line of defence, not the only one. The
// words survive (the model still reads what the customer wrote); the syntax
// that makes them instructions does not. Pure.
const SPOOFED_SYSTEM_MARKER = /\[\s*studio\s+system[^\]\n]*\]?/gi
const SPOOFED_SENTINEL = /\[\[?\s*(?:handoff|options|skip)\s*\]?\]?/gi
export function sanitizeInboundText(s) {
  return String(s ?? '')
    .replace(SPOOFED_SYSTEM_MARKER, 'studio system')
    .replace(SPOOFED_SENTINEL, (m) => m.replace(/[[\]]/g, ''))
}

/**
 * Map stored whatsapp_messages rows into an Anthropic messages array.
 * inbound → user, outbound → assistant. Drops empty/media-only rows to
 * a placeholder, keeps the last `maxMessages`, and ensures the array
 * starts with a user turn (Anthropic requires it).
 *
 * @param {Array<{direction:string,body?:string,message_type?:string}>} rows  ascending by time
 * @param {object} [opts]
 * @param {number} [opts.maxMessages=20]
 */
export function formatHistoryForClaude(rows, opts = {}) {
  const maxMessages = opts.maxMessages ?? 20
  const recent = (rows || []).slice(-maxMessages)
  const mapped = []
  for (const r of recent) {
    const role = r.direction === 'inbound' ? 'user' : 'assistant'
    // HARDEN.2 — inbound text is untrusted: neutralise the markers that carry
    // authority in this protocol before it enters history.
    let text = (role === 'user' ? sanitizeInboundText(r.body) : (r.body || '')).trim()
    if (!text) {
      const t = r.message_type && r.message_type !== 'text' ? r.message_type : 'message'
      text = `[${t}]`
    }
    // Merge consecutive same-role turns so the array strictly alternates-ish
    // (Anthropic tolerates non-alternation, but merging keeps it clean).
    const last = mapped[mapped.length - 1]
    if (last && last.role === role) {
      last.content += `\n${text}`
    } else {
      mapped.push({ role, content: text })
    }
  }
  // Anthropic requires the first turn to be a user turn. But a thread that
  // OPENS with outbound messages — a broadcast / template / proactive message
  // that often ASKED something ("how did you find your trial?") — must not lose
  // that opener, or the agent replies to the customer's answer as a cold open
  // and re-asks the same question. So instead of DROPPING leading assistant
  // turns, fold their text into the first user turn as a labelled context
  // preamble so the conversation flows. (Also covers the case where the
  // maxMessages window happens to start on an assistant turn mid-thread.)
  const leading = []
  while (mapped.length && mapped[0].role !== 'user') {
    leading.push(mapped.shift().content)
  }
  if (leading.length && mapped.length) {
    const prior = leading.join('\n')
    mapped[0] = {
      role: 'user',
      content: `(Context — the conversation so far. Your earlier message${leading.length > 1 ? 's' : ''} to this customer, which they are now replying to:\n"${prior}"\nContinue that conversation naturally — don't reintroduce yourself or re-ask what you already asked.)\n\n${mapped[0].content}`,
    }
  }
  return mapped
}

/**
 * Interpret the model's raw reply text. Pure.
 * Returns { action: 'reply'|'handoff', text, reason }.
 *  - handoff: model emitted the HANDOFF sentinel → reason carries the
 *    internal note; `text` is empty (caller sends a holding message).
 *  - reply: normal customer-facing text.
 */
const MAX_OPTIONS = 10
const MAX_OPTION_CHARS = 20 // quick-reply button title cap (the tighter of Meta's limits)

/**
 * Normalize a raw [[OPTIONS]] payload: split on |, trim, drop empties,
 * dedupe, cap count and title length. Returns null unless at least two
 * usable choices remain (one button is worse than plain text). Pure.
 */
export function normalizeAgentOptions(raw) {
  const seen = new Set()
  const out = []
  for (const part of String(raw || '').split('|')) {
    const label = part.trim().slice(0, MAX_OPTION_CHARS)
    if (!label || seen.has(label)) continue
    seen.add(label)
    out.push(label)
    if (out.length >= MAX_OPTIONS) break
  }
  return out.length >= 2 ? out : null
}

// HARDEN.1 — match the sentinels LOOSELY: case-insensitive and tolerant of
// padding inside the brackets ('[[ handoff ]]'). Built from the canonical
// prefixes in prompt.js so the token stays single-sourced. The model
// occasionally varies the exact format; an exact-substring match would then
// leak the raw "[[HANDOFF]]" to the customer or silently drop the buttons.
function looseSentinel(prefix) {
  const token = prefix.replace(/^\[\[|\]\]$/g, '').trim()
  return new RegExp(`\\[\\[\\s*${token}\\s*\\]\\]`, 'i')
}
const HANDOFF_RE = looseSentinel(HANDOFF_PREFIX)
const OPTIONS_RE = looseSentinel(OPTIONS_PREFIX)
const SKIP_RE = looseSentinel(SKIP_PREFIX)

// HARDEN.3 — the OPENING half of a sentinel, for a reply truncated at
// max_tokens or emitted with the closing brackets dropped ("[[HANDOFF wants a
// refund"). The closed forms above are matched first; whatever is left that
// still opens a sentinel must never reach the customer as body text.
const HANDOFF_OPEN_RE = /\[\[\s*HANDOFF/i
const OPTIONS_OPEN_RE = /\[\[\s*OPTIONS/i

/**
 * Does this model output carry the [[SKIP]] sentinel? Matched as leniently as
 * the other two (case + bracket padding + a dropped closing pair), because the
 * proactive paths SEND whatever isn't a skip — a missed "[[skip]]" ships the
 * literal token to the customer as a proactive message. Pure.
 */
export function isSkipResponse(raw) {
  const s = String(raw || '')
  return SKIP_RE.test(s) || /\[\[\s*SKIP/i.test(s)
}

// Markdown emphasis / whitespace that can wrap a sentinel or trail a line —
// stripped at the edges so '**[[OPTIONS]]**' or '[[options]] 7am' don't drag
// markup into the customer text or a button label.
const SENTINEL_WRAP = /^[\s*_`~]+|[\s*_`~]+$/g

/**
 * Cut the first `match` and the remainder of its line out of `text`. Returns
 * the cut payload (that line's remainder) plus the surviving text. A leading
 * ']' survives a half-closed sentinel, so it's trimmed off the payload. Pure.
 */
function cutSentinelLine(text, match) {
  const after = text.slice(match.index + match[0].length)
  const newline = after.indexOf('\n')
  const payload = (newline === -1 ? after : after.slice(0, newline))
    .replace(/^[\]\s]+/, '')
    .replace(SENTINEL_WRAP, '')
  const rest = newline === -1 ? '' : after.slice(newline + 1)
  return { payload, text: (text.slice(0, match.index) + rest).replace(SENTINEL_WRAP, '').trim() }
}

// AGENT-ACTIVITY.1 — "customer is chatting with Mia" staff ping is debounced to
// once per active chat: after we notify, stay quiet until this long has passed
// with the conversation still live. One ping per burst, not per message.
export const AGENT_ACTIVITY_DEBOUNCE_MS = 15 * 60_000

/**
 * Should we send the agent-activity ping for this conversation now? True when
 * we've never pinged, or the last ping is older than the debounce window.
 * Pure — the caller stamps agent_activity_notified_at on a true result.
 * @param {string|Date|null} lastNotifiedAt
 * @param {Date} [now]
 * @param {number} [windowMs]
 */
export function shouldNotifyAgentActivity(lastNotifiedAt, now = new Date(), windowMs = AGENT_ACTIVITY_DEBOUNCE_MS) {
  if (!lastNotifiedAt) return true
  const last = lastNotifiedAt instanceof Date ? lastNotifiedAt : new Date(lastNotifiedAt)
  const t = last.getTime()
  if (!Number.isFinite(t)) return true
  return now.getTime() - t >= windowMs
}

// HUMANIZE.1 — em/en dashes are the tell that a message was AI-written, and
// Richard wants them out of every customer-facing agent message. A prompt rule
// alone isn't reliable, so we also scrub deterministically here (the single
// parse point for both live replies and follow-up nudges). A dash flanked by a
// space reads as a clause break → comma; a tight dash (time ranges like
// "5:00–5:30", "pre–class") → hyphen. Studio names already use plain hyphens
// ("BASE - STRENGTH"), so they're untouched.
export function stripEmDashes(s) {
  return String(s ?? '')
    .replace(/\s*[—–]\s+/g, ', ')
    .replace(/\s+[—–]\s*/g, ', ')
    .replace(/[—–]/g, '-')
}

export function parseAgentResponse(raw) {
  let text = String(raw || '').trim()
  // Detect the sentinel ANYWHERE, not just at the start — if the model
  // emits a sentence before it (occasionally happens), we must still hand
  // off rather than leak the raw "[[HANDOFF]] reason" to the customer.
  const h = text.match(HANDOFF_RE) || text.match(HANDOFF_OPEN_RE)
  if (h) {
    const reason = text.slice(h.index + h[0].length)
      .replace(/^[\]\s]+/, '')
      .replace(SENTINEL_WRAP, '')
      .trim()
    return { action: 'handoff', text: '', reason: reason || 'unspecified' }
  }

  // AGENT-UX.1 — a trailing [[OPTIONS]] a | b | c line becomes tap
  // buttons. Strip the sentinel from the text UNCONDITIONALLY (even if
  // the payload is unusable) so it can never leak to the customer — and
  // strip EVERY occurrence, not just the first: a model that restates the
  // choices used to send its second options line verbatim to the customer.
  // Only the first payload is the options source (the prompt asks for one
  // line); later ones are dropped with their sentinel.
  let options = null
  for (let m = text.match(OPTIONS_RE); m; m = text.match(OPTIONS_RE)) {
    const cut = cutSentinelLine(text, m)
    // Scrub dashes from button labels too ("Yes — book me in" → "Yes, book me in").
    if (!options) options = normalizeAgentOptions(stripEmDashes(cut.payload))
    text = cut.text
  }
  // HARDEN.3 — same for a bracket-dropped "[[OPTIONS 7am | 8am": it would
  // otherwise render as body text.
  const openOptions = text.match(OPTIONS_OPEN_RE)
  if (openOptions) {
    const cut = cutSentinelLine(text, openOptions)
    if (!options) options = normalizeAgentOptions(stripEmDashes(cut.payload))
    text = cut.text
  }

  if (!text) return { action: 'handoff', text: '', reason: 'empty_model_response' }
  const parsed = { action: 'reply', text: stripEmDashes(text), reason: 'ok' }
  if (options) parsed.options = options
  return parsed
}

/**
 * AGENT-AUTH.1 — WhatsApp phone-number authentication. Meta has already
 * authenticated the sender's number (SIM-bound — the same assurance as
 * an SMS one-time code), so on a trusted channel a sender whose number
 * maps to EXACTLY ONE contact — the one this conversation is linked to —
 * is verified without the email/DOB/surname questions. Ambiguous numbers
 * (a couple sharing a phone) and channels without a phone (Instagram)
 * return null and keep the question-based verify_identity flow. Pure.
 *
 * @param {object} args
 * @param {boolean} args.trusted                adapter.trustsSenderIdentity
 * @param {string|null} args.conversationContactId  conversation.contact_id
 * @param {Array<{id:string}>|null} args.matches    contacts matching the sender's number at this location (capped query)
 * @returns {string|null} the verified contact id, or null
 */
export function autoVerifyContactId({ trusted, conversationContactId, matches }) {
  if (!trusted || !conversationContactId) return null
  if (!Array.isArray(matches) || matches.length !== 1) return null
  return matches[0]?.id === conversationContactId ? conversationContactId : null
}

/**
 * AGENT-AUTH.2 — link-aware extension of autoVerifyContactId. Pure.
 *
 * When the sender's number maps to MORE THAN ONE contact, the exactly-one rule
 * bails — a number shared by two DIFFERENT people must never auto-verify into
 * the wrong account. But duplicate records of the SAME person, linked into one
 * person_group, should collapse to a single identity. This decides
 * verification by PERSON (not raw contact row): it verifies when every matched
 * contact is the same person as the conversation's contact — each match either
 * IS the thread contact or shares its person-group. A match outside that group
 * (or any second contact when the thread contact is ungrouped) means a real
 * stranger could hold the number → returns null → falls back to the quiz.
 *
 * PERSON-ACCT.6 — on success the acting account is the CONVERSATION'S OWN
 * contact, not the group's primary. The primary is a DISPLAY/outreach ranking
 * (`pickPrimary`, person-links.js) that knows nothing about which account holds
 * the person's activity: 879 of 887 person_groups hold divergent Glofox
 * accounts, so swapping in the primary read an empty sibling account and told a
 * member with a staff-made booking "I don't see any classes booked for you"
 * (live, 2026-08-25). Since PR1 every read spans the whole group
 * (person-accounts.js), so the acting contact only has to be the person's
 * ANCHOR — and the thread's own contact is the one the customer is actually
 * talking on. The same-person check above is unaffected: it still decides
 * WHETHER this verifies; only the id handed back changed.
 *
 * Group data is injected as pure closures so this stays IO-free; the batch
 * resolver that builds them lives in person-links.js (`personGroupResolver`).
 *
 * @param {object} args
 * @param {boolean} args.trusted                 adapter.trustsSenderIdentity
 * @param {string|null} args.conversationContactId
 * @param {Array<{id:string}>|null} args.matches contacts matching the sender's number at this location
 * @param {(contactId:string)=>string|null} args.groupOf   person-group id for a contact, or null
 * @returns {{ actingContactId: string } | null}
 */
export function resolveAutoVerify({ trusted, conversationContactId, matches, groupOf }) {
  if (!trusted || !conversationContactId) return null
  if (!Array.isArray(matches) || matches.length === 0) return null

  const convGroup = (groupOf && groupOf(conversationContactId)) || null

  // Every match must resolve to the SAME person as the conversation contact.
  const allSamePerson = matches.every((m) => {
    if (!m || !m.id) return false
    if (m.id === conversationContactId) return true
    if (!convGroup) return false  // an ungrouped thread contact can't collapse a 2nd contact
    return ((groupOf && groupOf(m.id)) || null) === convGroup
  })
  if (!allSamePerson) return null

  return { actingContactId: conversationContactId }
}

/**
 * Resolve a contact to its person-group's primary. Pure.
 * If the contact is part of a person_group, returns the group's primary
 * (`primary_contact_id`, ranked by `pickPrimary` in person-links.js);
 * otherwise the contact itself.
 *
 * PERSON-ACCT.6 — this is a DISPLAY-ONLY resolution now: which row a human (or
 * a greeting) should be shown as "the" record for this person. It must NOT be
 * used to decide which account the agent ACTS on — `pickPrimary` ranks for
 * outreach and knows nothing about which account holds the person's bookings,
 * membership or credits, so acting on it silently answered from an empty
 * sibling account. Reads span the whole group (person-accounts.js); writes
 * elect an account (`electWriteAccount`). Kept exported because the display
 * question is a real one and the agent's name/greeting block still asks it.
 */
export function resolveActingContactId({ contactId, groupOf, primaryOf }) {
  if (!contactId) return contactId
  const g = (groupOf && groupOf(contactId)) || null
  if (!g) return contactId
  return (primaryOf && primaryOf(g)) || contactId
}

/**
 * AGENT-AUTH.3 — count distinct PEOPLE among the contacts matched on a sender's
 * number. A person = their person-group id when grouped, else the contact id
 * itself, so N duplicate rows already linked as one Person count once. Pure.
 *
 * ≥2 means the number is linked to more than one account, so the agent can't
 * auto-identify the sender and asks WHICH account (by email) rather than the
 * blind email+surname quiz. `groupOf` is the closure from personGroupResolver.
 * @param {Array<{id:string}>|null} matches contacts matching the sender's number
 * @param {(contactId:string)=>string|null} groupOf
 * @returns {number}
 */
export function distinctPersonCount(matches, groupOf) {
  const people = new Set()
  for (const m of matches || []) {
    if (!m || !m.id) continue
    people.add((groupOf && groupOf(m.id)) || m.id)
  }
  return people.size
}

// How long a successful identity verification stays valid on a thread.
// After this, the customer must re-verify before any account lookup or
// pause/cancel request — so a phone/IG handle changing hands doesn't
// inherit a stale verification.
export const VERIFY_TTL_MS = 30 * 24 * 60 * 60 * 1000

/**
 * Is a stored verification still fresh? Pure. Returns false when there's
 * no timestamp or it's older than VERIFY_TTL_MS.
 * @param {string|null} verifiedAt  ISO timestamp of agent_verified_at
 * @param {Date} [now]
 * @param {number} [ttlMs]
 */
export function isVerificationFresh(verifiedAt, now = new Date(), ttlMs = VERIFY_TTL_MS) {
  if (!verifiedAt) return false
  const t = new Date(verifiedAt).getTime()
  if (Number.isNaN(t)) return false
  return now.getTime() - t < ttlMs
}

// EFFORT.1 — output_config.effort tuning for the inbound reply. The Messages
// API defaults effort to `high`, which over-thinks a short transactional
// WhatsApp reply (more tokens, more latency, longer preamble). Operators set
// settings.customer_agent.effort per location; we clamp to a valid enum and
// default to a balanced `medium` (one notch below the API default — `low` is
// the chat-recommended floor for max savings). Pure, so the request can never
// carry an effort value the API would 400 on.
const AGENT_EFFORT_LEVELS = ['low', 'medium', 'high', 'max']
export const DEFAULT_AGENT_EFFORT = 'medium'
export function resolveAgentEffort(raw) {
  const v = String(raw ?? '').trim().toLowerCase()
  return AGENT_EFFORT_LEVELS.includes(v) ? v : DEFAULT_AGENT_EFFORT
}

// AGENT-VERIFY-HANDOFF.1 — auto-hand-off after repeated identity-verification
// failures so Mia can't loop a customer on the email+surname quiz. The count
// lives on the conversation (agent_verify_attempts); these pure helpers own the
// threshold + counter arithmetic so the auto-reply wiring stays thin.
export const VERIFY_FAIL_HANDOFF_DEFAULT = 2

// Per-location threshold from the agent settings blob. 0/negative disables the
// auto-handoff. Mirrors resolveHandoffSlaMinutes. Pure.
export function resolveVerifyFailHandoff(settings) {
  const raw = Number(settings?.handoff_after_verify_failures)
  if (!Number.isFinite(raw)) return VERIFY_FAIL_HANDOFF_DEFAULT
  return raw > 0 ? Math.round(raw) : 0
}

// Should this many consecutive failed attempts trigger a handoff? Pure.
export function shouldHandoffAfterVerifyFail(attempts, threshold) {
  return threshold > 0 && (Number(attempts) || 0) >= threshold
}

// New failed-attempt count given a verify_identity tool result: reset to 0 on
// success, +1 on an explicit failure, unchanged for any other result. Pure.
export function nextVerifyAttempts(current, result) {
  const n = Number(current) || 0
  if (!result || typeof result.verified !== 'boolean') return n
  return result.verified ? 0 : n + 1
}
