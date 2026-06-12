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

export function shouldAgentReply({ settings, conversation, message, senderPhone, now = new Date() }) {
  const s = settings || {}
  const enabled = !!s.enabled
  const testMode = !!s.test_mode
  if (!enabled && !testMode) return { reply: false, reason: 'disabled' }

  // Per-conversation kill switch (human takeover / prior escalation).
  // AGENT-REARM.1 — a handoff auto-releases after the configured
  // cooldown so one escalation doesn't silence the agent forever; the
  // rearm flag tells the caller to clear the handoff stamp in the DB.
  // A manual agent-off (no handoff timestamp) never auto-releases.
  let rearm = false
  if (conversation && conversation.agent_active === false) {
    const cooldown = s.handoff_cooldown_hours ?? DEFAULT_HANDOFF_COOLDOWN_HOURS
    if (!isHandoffExpired(conversation.agent_handed_off_at, cooldown, now)) {
      return { reply: false, reason: 'handed_off' }
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
  const type = message?.type || 'text'
  if (type !== 'text' && type !== 'interactive') return { reply: false, reason: 'unsupported_type', onDuty: true }
  if (!String(message?.body || '').trim()) return { reply: false, reason: 'empty', onDuty: true }

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
  // Anthropic requires the first message to be a user turn.
  while (mapped.length && mapped[0].role !== 'user') mapped.shift()
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

export function parseAgentResponse(raw) {
  let text = String(raw || '').trim()
  // Detect the sentinel ANYWHERE, not just at the start — if the model
  // emits a sentence before it (occasionally happens), we must still hand
  // off rather than leak the raw "[[HANDOFF]] reason" to the customer.
  const idx = text.indexOf(HANDOFF_PREFIX)
  if (idx !== -1) {
    return { action: 'handoff', text: '', reason: text.slice(idx + HANDOFF_PREFIX.length).trim() || 'unspecified' }
  }

  // AGENT-UX.1 — a trailing [[OPTIONS]] a | b | c line becomes tap
  // buttons. Strip the sentinel from the text UNCONDITIONALLY (even if
  // the payload is unusable) so it can never leak to the customer.
  let options = null
  const oIdx = text.indexOf(OPTIONS_PREFIX)
  if (oIdx !== -1) {
    const after = text.slice(oIdx + OPTIONS_PREFIX.length)
    const newline = after.indexOf('\n')
    const payload = newline === -1 ? after : after.slice(0, newline)
    const rest = newline === -1 ? '' : after.slice(newline + 1)
    options = normalizeAgentOptions(payload)
    text = (text.slice(0, oIdx) + rest).trim()
  }

  if (!text) return { action: 'handoff', text: '', reason: 'empty_model_response' }
  const parsed = { action: 'reply', text, reason: 'ok' }
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
