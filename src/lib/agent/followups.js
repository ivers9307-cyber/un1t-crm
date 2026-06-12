// AGENT-FOLLOWUP.1 — Mia's proactive follow-ups (spec:
// docs/AGENT_FOLLOWUPS_SPEC.md, approved by Richard 2026-06-12).
//
// The ladder, per intent cycle (a cycle = the customer goes quiet on
// an open agent offer; any inbound reply resets it via the webhook):
//   stage 1 — IN-WINDOW nudge, 3–20h after their last message: Mia
//             composes ONE short contextual free-form follow-up
//             (allowed — we're inside WhatsApp's 24h window; the 20h
//             ceiling leaves margin before it shuts).
//   stage 2 — OUTSIDE the window, 24–48h: ONE approved marketing
//             template (consent-gated) whose only job is earning a
//             reply — any reply re-opens the 24h window and the
//             normal agent takes over automatically.
//   stage 3 — closed: nothing open to chase (model said so), or the
//             cycle expired. Long-cycle nurture belongs to the
//             existing sequences/radars, not here.
//
// Safety: per-cycle one send per stage, per-location daily cap,
// Dublin daytime only, skip handed-off/resolved/human-active threads
// and pause/cancel cycles, default OFF
// (settings.customer_agent.followups.enabled). Every skip logs a
// structured reason — silence must always be explainable (#478).

import { buildCustomerSystemPrompt } from './prompt'
import { formatHistoryForClaude, parseAgentResponse, phoneMatchesAllowlist } from './core'

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages'
const AGENT_MODEL = 'claude-sonnet-4-6'
const H_MS = 3600_000

export const FOLLOWUP_DEFAULTS = {
  enabled: false,
  nudge_after_hours: 3,
  template_name: null,
  daily_cap: 50,
}

// Window bands (hours since the customer's last message).
const NUDGE_MAX_H = 20      // margin before the 24h window shuts
const TEMPLATE_MIN_H = 24
const TEMPLATE_MAX_H = 48

// ── pure decisions ──────────────────────────────────────────────────

/**
 * Decide what (if anything) to send for one quiet conversation.
 * Returns { action: 'nudge' | 'template' | null, reason? }. Pure.
 */
export function classifyFollowupCandidate({
  stage = 0,
  lastInboundAtMs,
  agentSpokeAfterInbound,
  humanSpokeAfterInbound,
  sensitiveIntent,
  intentClosed,
  nowMs,
  nudgeAfterHours = FOLLOWUP_DEFAULTS.nudge_after_hours,
} = {}) {
  if (!lastInboundAtMs) return { action: null, reason: 'no_inbound' }
  if (humanSpokeAfterInbound) return { action: null, reason: 'human_active' }
  if (sensitiveIntent) return { action: null, reason: 'sensitive_intent' }
  if (intentClosed) return { action: null, reason: 'concluded' }
  if (!agentSpokeAfterInbound) return { action: null, reason: 'no_open_offer' }

  const ageH = (nowMs - lastInboundAtMs) / H_MS
  if (ageH < nudgeAfterHours) return { action: null, reason: 'too_soon' }
  if (ageH <= NUDGE_MAX_H) {
    return stage === 0 ? { action: 'nudge' } : { action: null, reason: 'already_nudged' }
  }
  if (ageH < TEMPLATE_MIN_H) return { action: null, reason: 'window_margin' }
  if (ageH <= TEMPLATE_MAX_H) {
    return stage <= 1 ? { action: 'template' } : { action: null, reason: 'already_templated' }
  }
  return { action: null, reason: 'expired' }
}

const DUBLIN_HOUR_FMT = new Intl.DateTimeFormat('en-IE', {
  timeZone: 'Europe/Dublin', hour: 'numeric', hour12: false,
})

/** Proactive sends only between 09:00 and 19:59 Dublin. Pure. */
export function withinDublinDaytime(nowMs) {
  const hour = Number(DUBLIN_HOUR_FMT.format(new Date(nowMs)))
  return hour >= 9 && hour < 20
}

/**
 * A short human topic for the template's {{2}} — derived from what
 * the agent was last talking about. Deliberately coarse. Pure.
 */
export function deriveFollowupTopic(agentMessages) {
  const text = (agentMessages || []).join(' ').toLowerCase()
  if (/consult|intro session|taster/.test(text)) return 'booking a consultation'
  if (/class|session|timetable|book you in/.test(text)) return 'booking a class'
  if (/membership|price|cost|join/.test(text)) return 'membership options'
  return 'your question'
}

/** Positional body params for sendTemplateMessage. Pads short lists. Pure. */
export function buildFollowupComponents(varCount, values) {
  const n = Number(varCount) || 0
  if (n < 1) return []
  const vals = (values || []).filter((v) => v != null && String(v).trim() !== '')
  const last = vals[vals.length - 1] || 'there'
  const parameters = Array.from({ length: n }, (_, i) => ({
    type: 'text',
    text: String(vals[i] ?? last),
  }))
  return [{ type: 'body', parameters }]
}

/** The template body as the customer reads it — for thread recording. Pure. */
export function renderFollowupBody(template, values) {
  const body = (template?.components || []).find(
    (c) => String(c?.type || '').toUpperCase() === 'BODY',
  )?.text
  if (!body) return null
  const last = values?.[values.length - 1] || 'there'
  return body.replace(/\{\{(\d+)\}\}/g, (_, i) => String(values?.[Number(i) - 1] ?? last))
}

const NUDGE_INSTRUCTION =
  '[STUDIO SYSTEM — not the customer] The customer has gone quiet since your last message. ' +
  'Write ONE short, warm follow-up (1–2 sentences) that gently moves their open request ' +
  "forward — reference what they were asking about. No new topics, no pressure, don't " +
  'introduce yourself again. If there is genuinely nothing open to follow up on, reply with ' +
  'exactly [[SKIP]] and nothing else.'

// ── the runner (IO) ─────────────────────────────────────────────────

async function lastInboundFacts(db, conversationId) {
  const { data } = await db.from('whatsapp_messages')
    .select('direction, source, body, created_at, message_type')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(15)
  const rows = (data || []).slice().reverse()
  let lastInboundAtMs = null
  let agentSpokeAfterInbound = false
  let humanSpokeAfterInbound = false
  const agentTexts = []
  for (const m of rows) {
    if (m.direction === 'inbound') {
      lastInboundAtMs = new Date(m.created_at).getTime()
      agentSpokeAfterInbound = false
      humanSpokeAfterInbound = false
    } else if (m.source === 'agent') {
      agentSpokeAfterInbound = true
      if (m.body) agentTexts.push(m.body)
    } else {
      // operator / api sends after the inbound = a human owns the thread
      humanSpokeAfterInbound = true
    }
  }
  return { rows, lastInboundAtMs, agentSpokeAfterInbound, humanSpokeAfterInbound, agentTexts }
}

async function intentFlags(db, conversationId, lastInboundAtMs) {
  if (!lastInboundAtMs) return { sensitiveIntent: false, intentClosed: false }
  const sinceIso = new Date(lastInboundAtMs).toISOString()
  const { data } = await db.from('agent_membership_requests')
    .select('kind, status')
    .eq('conversation_id', conversationId)
    .gte('created_at', sinceIso)
    .limit(10)
  const rows = data || []
  return {
    // never chase someone who asked to pause or cancel
    sensitiveIntent: rows.some((r) => r.kind === 'pause' || r.kind === 'cancellation'),
    // a booking/cancellation that actually executed closed the cycle
    intentClosed: rows.some((r) => r.status === 'actioned'),
  }
}

async function sentTodayCount(db, locationId, nowMs) {
  const d = new Date(nowMs)
  const dayStart = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString()
  const { count } = await db.from('whatsapp_conversations')
    .select('id', { count: 'exact', head: true })
    .eq('location_id', locationId)
    .gte('agent_followup_sent_at', dayStart)
  return count || 0
}

function skipLog(conversationId, reason) {
  console.warn('[radar-agent] followup-skip', JSON.stringify({ conversationId, reason }))
}

async function recordProactiveMessage(db, conv, { body, waMessageId, messageType, templateName }) {
  const { error } = await db.from('whatsapp_messages').insert({
    conversation_id: conv.id,
    contact_id: conv.contact_id,
    location_id: conv.location_id,
    wa_message_id: waMessageId || null,
    direction: 'outbound',
    message_type: messageType,
    template_name: templateName || null,
    body,
    source: 'agent',
    status: 'sent',
    sent_at: new Date().toISOString(),
  })
  if (error) console.error('[radar-agent] followup record failed (history will be incomplete):', error.message)
}

async function stampStage(db, conversationId, stage, sent) {
  await db.from('whatsapp_conversations')
    .update({
      agent_followup_stage: stage,
      ...(sent ? { agent_followup_sent_at: new Date().toISOString() } : {}),
    })
    .eq('id', conversationId)
}

async function sendNudge(db, conv, location, settings, facts) {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return skipLog(conv.id, 'no_api_key')

  const system = buildCustomerSystemPrompt({
    businessName: 'UN1T',
    locationName: location.name,
    agentName: settings?.agent_name || null,
    tone: settings?.tone || null,
    extraRules: settings?.extra_rules || null,
    today: new Date().toDateString(),
  })
  const messages = [
    ...formatHistoryForClaude(facts.rows),
    { role: 'user', content: NUDGE_INSTRUCTION },
  ]
  let text = null
  try {
    const res = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({ model: AGENT_MODEL, max_tokens: 300, system, messages }),
    })
    if (!res.ok) return skipLog(conv.id, `nudge_model_http_${res.status}`)
    const body = await res.json()
    text = (body?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim()
  } catch (e) {
    return skipLog(conv.id, `nudge_model_error:${e?.message || e}`)
  }

  if (!text || /\[\[SKIP\]\]/.test(text)) {
    await stampStage(db, conv.id, 3, false) // nothing open — close the cycle quietly
    return skipLog(conv.id, 'nothing_open')
  }
  const parsed = parseAgentResponse(text)
  if (parsed.handoff || !parsed.text) {
    await stampStage(db, conv.id, 3, false)
    return skipLog(conv.id, 'nudge_not_sendable')
  }

  const { sendTextMessage } = await import('@/lib/whatsapp')
  const res = await sendTextMessage(conv.to, parsed.text, { locationId: conv.location_id })
  if (!res?.messageId) return skipLog(conv.id, 'nudge_send_failed')
  await recordProactiveMessage(db, conv, { body: parsed.text, waMessageId: res.messageId, messageType: 'text' })
  await stampStage(db, conv.id, 1, true)
  return { sent: 'nudge' }
}

async function sendFollowupTemplate(db, conv, settings, facts) {
  const followups = { ...FOLLOWUP_DEFAULTS, ...(settings?.followups || {}) }
  if (!followups.template_name) return skipLog(conv.id, 'no_template_configured')

  // Marketing template ⇒ marketing consent, exactly like a campaign.
  const { data: prefs } = await db.from('contact_preferences')
    .select('whatsapp_marketing')
    .eq('contact_id', conv.contact_id)
    .maybeSingle()
  if (prefs?.whatsapp_marketing !== true) {
    await stampStage(db, conv.id, 3, false)
    return skipLog(conv.id, 'no_marketing_consent')
  }

  const { data: rows } = await db.from('whatsapp_templates')
    .select('name, language, status, components, header_media_url')
    .eq('location_id', conv.location_id)
    .eq('name', followups.template_name)
    .order('created_at', { ascending: false })
    .limit(1)
  const template = rows?.[0]
  if (!template || String(template.status || '').toUpperCase() !== 'APPROVED') {
    return skipLog(conv.id, 'template_not_approved')
  }

  const { extractTemplateBody } = await import('@/lib/radar-outreach')
  const { sendTemplateMessage, headerComponentFor } = await import('@/lib/whatsapp')
  const { varCount } = extractTemplateBody(template.components)
  const values = [conv.firstName, deriveFollowupTopic(facts.agentTexts)]
  const components = buildFollowupComponents(varCount, values)
  const headerComponent = headerComponentFor(template.components, template.header_media_url)
  if (headerComponent) components.unshift(headerComponent)

  const res = await sendTemplateMessage(conv.to, template.name, template.language || 'en', components, {
    locationId: conv.location_id,
  })
  if (!res?.messageId) return skipLog(conv.id, 'template_send_failed')
  await recordProactiveMessage(db, conv, {
    body: renderFollowupBody(template, values) || `[Template: ${template.name}]`,
    waMessageId: res.messageId,
    messageType: 'template',
    templateName: template.name,
  })
  await stampStage(db, conv.id, 2, true)
  return { sent: 'template' }
}

/**
 * One cron tick: for every location with follow-ups enabled, find
 * quiet open agent conversations and run the ladder. Never throws.
 */
export async function runAgentFollowups(db, { nowMs = Date.now() } = {}) {
  const results = { nudges: 0, templates: 0, skipped: 0 }
  if (!withinDublinDaytime(nowMs)) return { ...results, reason: 'quiet_hours' }

  const { data: locations } = await db.from('locations')
    .select('id, name, settings')
    .eq('active', true)

  for (const location of locations || []) {
    const settings = location?.settings?.customer_agent || null
    const followups = { ...FOLLOWUP_DEFAULTS, ...(settings?.followups || {}) }
    if (!followups.enabled) continue
    // Follow-ups ride the agent: agent fully off ⇒ no proactive sends.
    if (!settings?.enabled && !settings?.test_mode) continue

    const sinceIso = new Date(nowMs - (TEMPLATE_MAX_H + 2) * H_MS).toISOString()
    const { data: convs } = await db.from('whatsapp_conversations')
      .select('id, contact_id, location_id, agent_active, agent_handed_off_at, resolved_at, agent_followup_stage, last_message_at, contacts!contact_id(first_name, name, wa_phone, phone, opted_out)')
      .eq('location_id', location.id)
      .eq('agent_active', true)
      .is('agent_handed_off_at', null)
      .lt('agent_followup_stage', 2)
      .gte('last_message_at', sinceIso)
      .order('last_message_at', { ascending: false })
      .limit(100)

    for (const c of convs || []) {
      try {
        const contact = c.contacts || {}
        const to = contact.wa_phone || contact.phone
        if (!to || contact.opted_out === true) { results.skipped++; continue }
        // Agent in test mode (not globally enabled): allowlist only.
        if (!settings?.enabled && settings?.test_mode &&
            !phoneMatchesAllowlist(to, settings?.test_phones)) {
          results.skipped++; continue
        }

        const facts = await lastInboundFacts(db, c.id)
        const flags = await intentFlags(db, c.id, facts.lastInboundAtMs)
        const decision = classifyFollowupCandidate({
          stage: c.agent_followup_stage,
          lastInboundAtMs: facts.lastInboundAtMs,
          agentSpokeAfterInbound: facts.agentSpokeAfterInbound,
          humanSpokeAfterInbound: facts.humanSpokeAfterInbound,
          sensitiveIntent: flags.sensitiveIntent,
          intentClosed: flags.intentClosed,
          nowMs,
          nudgeAfterHours: followups.nudge_after_hours,
        })
        if (!decision.action) { results.skipped++; continue }
        // resolved AFTER their last message ⇒ a human marked it handled.
        if (c.resolved_at && new Date(c.resolved_at).getTime() > facts.lastInboundAtMs) {
          results.skipped++; skipLog(c.id, 'human_resolved'); continue
        }

        if ((await sentTodayCount(db, location.id, nowMs)) >= followups.daily_cap) {
          skipLog(c.id, 'daily_cap'); break // cap is per location — stop this location
        }

        const conv = {
          id: c.id, contact_id: c.contact_id, location_id: c.location_id, to,
          firstName: (contact.first_name || String(contact.name || '').split(/\s+/)[0] || 'there').trim(),
        }
        const out = decision.action === 'nudge'
          ? await sendNudge(db, conv, location, settings, facts)
          : await sendFollowupTemplate(db, conv, settings, facts)
        if (out?.sent === 'nudge') results.nudges++
        else if (out?.sent === 'template') results.templates++
        else results.skipped++
      } catch (e) {
        results.skipped++
        console.error('[radar-agent] followup error:', e?.message || e)
      }
    }
  }
  return results
}
