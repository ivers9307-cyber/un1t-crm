// RADAR-AGENT.0 — pure runtime helpers for the customer agent.
//
// All functions here are pure (no DB, no network) so they can be
// unit-tested under the Node env. The IO orchestration lives in
// auto-reply.js; the webhook owns the trigger.

import { HANDOFF_PREFIX } from './prompt'

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
export function shouldAgentReply({ settings, conversation, message, senderPhone, now = new Date() }) {
  const s = settings || {}
  const enabled = !!s.enabled
  const testMode = !!s.test_mode
  if (!enabled && !testMode) return { reply: false, reason: 'disabled' }

  // Per-conversation kill switch (human takeover / prior escalation).
  if (conversation && conversation.agent_active === false) {
    return { reply: false, reason: 'handed_off' }
  }

  // Phase 0 only handles plain text. Anything else goes to a human.
  const type = message?.type || 'text'
  if (type !== 'text') return { reply: false, reason: 'unsupported_type' }
  if (!String(message?.body || '').trim()) return { reply: false, reason: 'empty' }

  // Test mode (not globally enabled): only reply to allow-listed numbers.
  if (!enabled && testMode) {
    if (!phoneMatchesAllowlist(senderPhone, s.test_phones)) {
      return { reply: false, reason: 'not_in_test_allowlist' }
    }
  }

  if (isWithinQuietHours(now, s.quiet_hours)) {
    return { reply: false, reason: 'quiet_hours' }
  }

  return { reply: true, reason: 'ok' }
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
export function parseAgentResponse(raw) {
  const text = String(raw || '').trim()
  if (text.startsWith(HANDOFF_PREFIX)) {
    return { action: 'handoff', text: '', reason: text.slice(HANDOFF_PREFIX.length).trim() || 'unspecified' }
  }
  if (!text) return { action: 'handoff', text: '', reason: 'empty_model_response' }
  return { action: 'reply', text, reason: 'ok' }
}
