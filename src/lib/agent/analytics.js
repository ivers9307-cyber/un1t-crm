// RADAR-AGENT — operator analytics (the "needs review" feed, plan §4e).
//
// Pure aggregation over the agent's own message + conversation rows.
// No new tables: everything is derived from columns that already exist
// on {whatsapp,instagram}_conversations + _messages —
//   - messages.direction ('inbound' | 'outbound')
//   - messages.source    ('agent' = the bot, anything else = human/api)
//   - conversations.agent_handed_off_at  (set when the agent escalated
//     OR a human took over)
//   - conversations.agent_verified_contact_id (identity verified in-thread)
//
// The IO layer (the API route) fetches the rows per channel and hands
// them here; these helpers stay pure so they're unit-testable with no DB.

import { AGENT_MESSAGE_SOURCE } from './core'

/**
 * Was this outbound message sent by the agent (vs a human operator)?
 * Agent rows carry source === 'agent'; operator replies use 'operator'
 * (IG) or null/'api' (WA). Pure.
 */
export function isAgentMessage(msg) {
  return msg?.direction === 'outbound' && msg?.source === AGENT_MESSAGE_SOURCE
}

/**
 * Normalise an inbound customer message into a coarse topic bucket by
 * keyword, so the feed can show "what got asked most" without storing
 * anything per-message. Deliberately simple + transparent — an operator
 * hint, not a classifier. Returns one of:
 * pause | cancellation | account | sales | hours | other. Pure.
 */
export function classifyInboundTopic(body) {
  const t = String(body || '').toLowerCase()
  if (!t.trim()) return 'other'
  if (/cancel|cancelling|cancellation|terminat/.test(t)) return 'cancellation'
  if (/paus|freeze|on hold|hold my|suspend/.test(t)) return 'pause'
  if (/price|cost|how much|membership option|sign ?up|join|trial|drop ?in|class ?pass|timetable|book a/.test(t)) return 'sales'
  if (/open|clos|opening hour|what time|hours/.test(t)) return 'hours'
  if (/my (membership|plan|account|booking|class)|am i|paid up|next class|what plan|booked/.test(t)) return 'account'
  return 'other'
}

/**
 * Summarise one channel's rows into the analytics shape. Pure.
 *
 * @param {object[]} conversations  rows with { id, agent_handed_off_at, agent_verified_contact_id }
 * @param {object[]} messages       rows with { conversation_id, direction, source, body }
 */
export function summariseChannel(conversations = [], messages = []) {
  const convs = Array.isArray(conversations) ? conversations : []
  const msgs = Array.isArray(messages) ? messages : []

  let agentReplies = 0
  let inboundTotal = 0
  const topics = {}
  const agentTouched = new Set()

  for (const m of msgs) {
    if (m?.direction === 'inbound') {
      inboundTotal++
      const topic = classifyInboundTopic(m.body)
      topics[topic] = (topics[topic] || 0) + 1
    } else if (isAgentMessage(m)) {
      agentReplies++
      if (m.conversation_id) agentTouched.add(m.conversation_id)
    }
  }

  const escalated = convs.filter(c => c?.agent_handed_off_at).length
  const verified = convs.filter(c => c?.agent_verified_contact_id).length

  return {
    conversations_total: convs.length,
    agent_handled: agentTouched.size,
    escalated,
    agent_replies: agentReplies,
    inbound_total: inboundTotal,
    verified,
    topics,
  }
}

/**
 * Merge two per-channel summaries (WhatsApp + Instagram) into a combined
 * one for the headline cards. Topic maps are summed key-wise. Pure.
 */
export function mergeSummaries(a, b) {
  const base = { conversations_total: 0, agent_handled: 0, escalated: 0, agent_replies: 0, inbound_total: 0, verified: 0, topics: {} }
  const out = { ...base }
  for (const s of [a, b]) {
    if (!s) continue
    out.conversations_total += s.conversations_total || 0
    out.agent_handled += s.agent_handled || 0
    out.escalated += s.escalated || 0
    out.agent_replies += s.agent_replies || 0
    out.inbound_total += s.inbound_total || 0
    out.verified += s.verified || 0
    for (const [k, v] of Object.entries(s.topics || {})) {
      out.topics[k] = (out.topics[k] || 0) + v
    }
  }
  return out
}

/**
 * Agent containment rate = share of agent-touched conversations that did
 * NOT escalate to a human. Returns a 0-100 integer, or null when there's
 * nothing to measure. Pure.
 */
export function containmentRate(summary) {
  const handled = summary?.agent_handled || 0
  if (handled === 0) return null
  const contained = Math.max(0, handled - (summary?.escalated || 0))
  return Math.round((contained / handled) * 100)
}

/**
 * Rank topics most-asked first, as [{ topic, count }]. Pure.
 */
export function rankTopics(topics = {}) {
  return Object.entries(topics)
    .map(([topic, count]) => ({ topic, count }))
    .sort((a, b) => b.count - a.count)
}

// AGENT-ANALYTICS.2 — business outcomes from the agent's audit trail
// (agent_membership_requests rows in the window). Pure.
const BOOKING_KINDS = new Set(['class_booking', 'event_booking', 'consultation'])
const CANCEL_KINDS = new Set(['class_cancellation', 'event_cancellation'])

export function summariseActions(rows = []) {
  const out = { bookings: 0, cancellations: 0, failed: 0, pending_approvals: 0 }
  for (const r of rows) {
    if (!r) continue
    if (r.status === 'pending') { out.pending_approvals++; continue }
    if (r.status === 'failed') { out.failed++; continue }
    if (r.status === 'actioned' && BOOKING_KINDS.has(r.kind)) out.bookings++
    else if (r.status === 'actioned' && CANCEL_KINDS.has(r.kind)) out.cancellations++
  }
  return out
}
