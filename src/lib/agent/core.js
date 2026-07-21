// RADAR-AGENT.0 — pure runtime helpers for the customer agent.
//
// All functions here are pure (no DB, no network) so they can be
// unit-tested under the Node env. The IO orchestration lives in
// auto-reply.js; the webhook owns the trigger.

import { HANDOFF_PREFIX, OPTIONS_PREFIX } from './prompt'

export const AGENT_MESSAGE_SOURCE = 'agent'
export const DEFAULT_HOLDING_MESSAGE =
  "Thanks for your message! One of the UN1T team will get back to you shortly."

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
    return { agent_active: true, agent_handed_off_at: null }
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

export function shouldAgentReply({ settings, conversation, message, senderPhone, lastOutboundHuman = false, now = new Date() }) {
  const s = settings || {}
  const enabled = !!s.enabled
  const testMode = !!s.test_mode
  if (!enabled && !testMode) return { reply: false, reason: 'disabled' }

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
    let text = (r.body || '').trim()
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
// Markdown emphasis / whitespace that can wrap a sentinel or trail a line —
// stripped at the edges so '**[[OPTIONS]]**' or '[[options]] 7am' don't drag
// markup into the customer text or a button label.
const SENTINEL_WRAP = /^[\s*_`~]+|[\s*_`~]+$/g

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
  const h = text.match(HANDOFF_RE)
  if (h) {
    const reason = text.slice(h.index + h[0].length).replace(SENTINEL_WRAP, '').trim()
    return { action: 'handoff', text: '', reason: reason || 'unspecified' }
  }

  // AGENT-UX.1 — a trailing [[OPTIONS]] a | b | c line becomes tap
  // buttons. Strip the sentinel from the text UNCONDITIONALLY (even if
  // the payload is unusable) so it can never leak to the customer.
  let options = null
  const o = text.match(OPTIONS_RE)
  if (o) {
    const after = text.slice(o.index + o[0].length)
    const newline = after.indexOf('\n')
    const payload = (newline === -1 ? after : after.slice(0, newline)).replace(SENTINEL_WRAP, '')
    const rest = newline === -1 ? '' : after.slice(newline + 1)
    // Scrub dashes from button labels too ("Yes — book me in" → "Yes, book me in").
    options = normalizeAgentOptions(stripEmDashes(payload))
    text = (text.slice(0, o.index) + rest).replace(SENTINEL_WRAP, '').trim()
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
 * On success the acting account resolves to the group's PRIMARY (the canonical
 * record) so bookings/lookups hit the right account, not a duplicate.
 *
 * Group data is injected as pure closures so this stays IO-free; the batch
 * resolver that builds them lives in person-links.js (`personGroupResolver`).
 *
 * @param {object} args
 * @param {boolean} args.trusted                 adapter.trustsSenderIdentity
 * @param {string|null} args.conversationContactId
 * @param {Array<{id:string}>|null} args.matches contacts matching the sender's number at this location
 * @param {(contactId:string)=>string|null} args.groupOf   person-group id for a contact, or null
 * @param {(groupId:string)=>string|null} args.primaryOf   the group's primary contact id, or null
 * @returns {{ actingContactId: string } | null}
 */
export function resolveAutoVerify({ trusted, conversationContactId, matches, groupOf, primaryOf }) {
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

  return { actingContactId: resolveActingContactId({ contactId: conversationContactId, groupOf, primaryOf }) }
}

/**
 * Resolve the account the agent should ACT on for a verified contact. Pure.
 * If the contact is part of a person_group, returns the group's primary (the
 * canonical account); otherwise the contact itself. Applied everywhere the
 * agent books or looks up an account so linked duplicates always resolve to
 * one record — including the email+surname quiz path, not just phone matches.
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
