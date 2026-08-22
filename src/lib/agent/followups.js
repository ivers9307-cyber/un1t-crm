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

import { buildCachedSystem, SKIP_PREFIX } from './prompt'
import { formatHistoryForClaude, parseAgentResponse, phoneMatchesAllowlist, isSkipResponse, isWithinQuietHours } from './core'
import { getLocationBranding } from '@/lib/location-branding'
import { anthropicMessages } from '@/lib/anthropic'
import { dublinTodayStr } from '@/lib/dublin-time'

const AGENT_MODEL = 'claude-sonnet-4-6'
const H_MS = 3600_000

export const FOLLOWUP_DEFAULTS = {
  enabled: false,
  nudge_after_hours: 3,
  template_name: null,
  daily_cap: 50,
}

export const CHECKIN_DEFAULTS = {
  enabled: false,
  delay_hours: 2,
  template_name: null,
  daily_cap: 20,
}

// Funnel stages that count as "new" — established members never get a
// first-class check-in (their first class was long ago; the stage
// gate is what tells a true first-timer from a returning regular).
// FUNNEL.1 — the four lead columns of the derived funnel.
const CHECKIN_STAGES = new Set(['new_lead', 'first_class', 'second_class', 'trial_done'])
const CHECKIN_MAX_AGE_H = 24

/**
 * AGENT-CHECKIN.1 — is this contact due their (once-ever) post-first-
 * class check-in? Pure.
 */
export function classifyCheckinCandidate({
  stage,
  lastAttendedAtMs,
  checkinSentAt,
  nowMs,
  delayHours = CHECKIN_DEFAULTS.delay_hours,
} = {}) {
  if (checkinSentAt) return { action: null, reason: 'already_sent' }
  if (!stage || !CHECKIN_STAGES.has(stage)) return { action: null, reason: 'not_new' }
  if (!lastAttendedAtMs) return { action: null, reason: 'no_attendance' }
  const ageH = (nowMs - lastAttendedAtMs) / H_MS
  if (ageH < delayHours) return { action: null, reason: 'too_soon' }
  if (ageH > CHECKIN_MAX_AGE_H) return { action: null, reason: 'expired' }
  return { action: 'checkin' }
}

/**
 * The class they actually attended — the attended booking nearest the
 * attendance stamp, from contacts.recent_bookings. Pure.
 */
export function attendedClassName(recentBookings, lastAttendedAtMs) {
  const targetSec = Math.floor((lastAttendedAtMs || 0) / 1000)
  let best = null
  let bestDelta = Infinity
  for (const b of Array.isArray(recentBookings) ? recentBookings : []) {
    if (!b || b.attended !== true) continue
    const delta = Math.abs((Number(b.time_start) || 0) - targetSec)
    if (delta < bestDelta) { bestDelta = delta; best = b }
  }
  return best?.event_name || best?.model_name || null
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
 * MIA-REVIEW.3 — may this LOCATION receive a Mia-initiated message right now?
 * Pure. Two gates, both must be open:
 *   1. the hard 09:00-19:59 Dublin daytime band (unchanged), and
 *   2. the operator's own settings.customer_agent.quiet_hours — the live REPLY
 *      path has always honoured it (core.isWithinQuietHours), and a message Mia
 *      starts herself must respect it at least as strictly. A studio that goes
 *      quiet at 18:00 was still getting nudges until 20:00.
 * A closed window is never a lost send: the runner rides a 15-minute cron and
 * the same candidate qualifies on the next tick inside the window.
 * @returns {{ open: boolean, reason?: string }}
 */
export function proactiveWindowOpen(nowMs, settings) {
  if (!withinDublinDaytime(nowMs)) return { open: false, reason: 'outside_daytime' }
  if (isWithinQuietHours(new Date(nowMs), settings?.quiet_hours)) {
    return { open: false, reason: 'operator_quiet_hours' }
  }
  return { open: true }
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

// The "[STUDIO SYSTEM]" marker is the studio's own channel into the model on
// the proactive paths. A customer cannot forge it: core.js sanitizeInboundText
// neutralises the marker (and the control sentinels) in inbound text before it
// reaches history (HARDEN.2).
const NUDGE_INSTRUCTION =
  '[STUDIO SYSTEM - not the customer] The customer has gone quiet since your last message. ' +
  'Write ONE short, warm follow-up (1-2 sentences) that gently moves their open request ' +
  "forward, referencing what they were asking about. No new topics, no pressure, don't " +
  'introduce yourself again. If there is genuinely nothing open to follow up on, reply with ' +
  `exactly ${SKIP_PREFIX} and nothing else.`

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

/**
 * The location's enabled knowledge, same query the live reply path runs
 * (auto-reply.js). Best-effort: a failure just yields an empty list.
 */
async function loadAgentKnowledge(db, locationId) {
  const { data } = await db.from('agent_knowledge')
    .select('category, title, content, enabled, sort_order')
    .eq('location_id', locationId)
    .eq('enabled', true)
    .order('sort_order', { ascending: true })
  return data || []
}

// One short proactive message in Mia's voice, given the thread + an
// instruction. Returns the text or null (callers log the reason).
//
// The prompt must match the live reply path: omitting `knowledge` rendered the
// "No knowledge has been added yet. You cannot answer factual questions" notice
// into every nudge and check-in, which is false whenever the location HAS
// knowledge and biases the model straight to [[SKIP]]/handoff (the first-class
// check-in's intro-offer framing depends on those facts). `today` is the Dublin
// business day for the same reason.
// Exported for tests (repo convention) — compose-effort.test.js asserts the
// request body, which is how MIA-HYGIENE.2 caught this path running at the
// API-default effort.
export async function composeAgentText({ location, settings, historyRows, instruction, companyName, knowledge }) {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return { error: 'no_api_key' }
  // CACHE.2 — cache the stable prefix (no tools on this path, so it caches the
  // stable system block directly); the date suffix stays uncached.
  const system = buildCachedSystem({
    businessName: companyName || 'UN1T',
    locationName: location.name,
    agentName: settings?.agent_name || null,
    membershipUrl: settings?.membership_signup_url || null,
    tone: settings?.tone || null,
    extraRules: settings?.extra_rules || null,
    knowledge: knowledge || [],
    today: dublinTodayStr(),
  })
  const messages = [
    ...formatHistoryForClaude(historyRows || []),
    { role: 'user', content: instruction },
  ]
  try {
    // SAAS4-M1 — metered via the shared wrapper (source: followups).
    const { res, data: body } = await anthropicMessages(
      // MIA-HYGIENE.2 — effort `low`: a proactive nudge is a short, scoped,
      // latency-tolerant generation. Without this the call ran at the API
      // default (`high`), which EFFORT.1 already rejected for the inbound
      // reply path.
      { model: AGENT_MODEL, max_tokens: 300, output_config: { effort: 'low' }, system, messages },
      { apiKey, locationId: location.id, source: 'followups' }
    )
    if (!res.ok) return { error: `model_http_${res.status}` }
    const text = (body?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim()
    return { text }
  } catch (e) {
    return { error: `model_error:${e?.message || e}` }
  }
}

async function sendNudge(db, conv, location, settings, facts) {
  const branding = await getLocationBranding(db, location.id)
  const composed = await composeAgentText({
    location, settings, historyRows: facts.rows, instruction: NUDGE_INSTRUCTION,
    companyName: branding.companyName,
    knowledge: await loadAgentKnowledge(db, location.id),
  })
  if (composed.error) return skipLog(conv.id, `nudge_${composed.error}`)
  const text = composed.text

  if (!text || isSkipResponse(text)) {
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
    // MIA-REVIEW.3 — the operator's quiet_hours apply to Mia-initiated sends
    // too, not just replies (the global daytime band is checked above).
    const window = proactiveWindowOpen(nowMs, settings)
    if (!window.open) {
      console.warn('[radar-agent] followup-skip', JSON.stringify({ locationId: location.id, reason: window.reason }))
      continue
    }

    const sinceIso = new Date(nowMs - (TEMPLATE_MAX_H + 2) * H_MS).toISOString()
    // wa_status is the hard opt-out signal (whatsapp-consent.js) — there is
    // NO contacts.opted_out column. Selecting one here silently killed every
    // tick for 3 weeks: PostgREST 400s the embed, supabase-js returns
    // { data: null, error } without throwing, and the loop saw zero
    // candidates. Hence the loud error log below — a candidate-query failure
    // must never read as "nothing to do" again.
    const { data: convs, error: convsError } = await db.from('whatsapp_conversations')
      .select('id, contact_id, location_id, agent_active, agent_handed_off_at, resolved_at, agent_followup_stage, last_message_at, contacts!contact_id(first_name, name, wa_phone, phone, wa_status)')
      .eq('location_id', location.id)
      .eq('agent_active', true)
      .is('agent_handed_off_at', null)
      // INBOX-REDESIGN.2.3 — a sticky operator pause (mig 435) gets no
      // proactive nudges either, same as a handed-off thread.
      .is('agent_paused_at', null)
      .lt('agent_followup_stage', 2)
      .gte('last_message_at', sinceIso)
      .order('last_message_at', { ascending: false })
      .limit(100)
    if (convsError) {
      console.error('[radar-agent] followup candidate query failed:', convsError.message)
      continue
    }

    for (const c of convs || []) {
      try {
        const contact = c.contacts || {}
        const to = contact.wa_phone || contact.phone
        if (!to || contact.wa_status === 'opted_out') { results.skipped++; continue }
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

// ── AGENT-CHECKIN.1 — post-first-class check-in ─────────────────────

function checkinInstruction(className) {
  return (
    '[STUDIO SYSTEM - not the customer] This customer attended their first ' +
    `${className} class earlier today. Send ONE short, warm check-in asking how it went, ` +
    'referencing the class by name. No selling in this message; just genuine interest. ' +
    `If the conversation already covered how it went, reply with exactly ${SKIP_PREFIX}.`
  )
}

/**
 * How many of today's check-in activity rows were actual SENDS. Pure.
 * stampCheckin writes the `via` label into the note ('in-window' / 'template'
 * for a send, 'skipped — …' for a non-send).
 */
export function countCheckinSends(rows) {
  return (rows || []).filter((r) => !/skipped/i.test(String(r?.note || ''))).length
}

// MIA-REVIEW.3 — the daily cap must measure SENDS. contacts
// .first_class_checkin_at is the once-ever marker and stampCheckin stamps it
// for non-sends too ('skipped — already discussed', 'skipped — no marketing
// consent'), so counting stamps let a consent-poor day eat the cap and stop
// genuine check-ins early. The activities row carries the via label, so count
// those; if that read fails we fall back to the old stamp count (over-counting
// under-sends, which is the safe direction).
async function checkinsSentToday(db, locationId, nowMs) {
  const d = new Date(nowMs)
  const dayStart = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString()
  const { data, error } = await db.from('activities')
    .select('note')
    .eq('location_id', locationId)
    .eq('type', 'agent_checkin')
    .gte('created_at', dayStart)
    .limit(500)
  if (!error && Array.isArray(data)) return countCheckinSends(data)
  const { count } = await db.from('contacts')
    .select('id', { count: 'exact', head: true })
    .eq('location_id', locationId)
    .gte('first_class_checkin_at', dayStart)
  return count || 0
}

async function stampCheckin(db, contact, locationId, className, via) {
  await db.from('contacts')
    .update({ first_class_checkin_at: new Date().toISOString() })
    .eq('id', contact.id)
  try {
    await db.from('activities').insert({
      contact_id: contact.id,
      location_id: locationId,
      type: 'agent_checkin',
      kind: 'event',
      subject: 'Mia checked in after their first class',
      note: `${className}${via ? ` (${via})` : ''}`,
    })
  } catch { /* timeline entry is best-effort */ }
}

/**
 * One cron tick of first-class check-ins (spec:
 * docs/AGENT_FIRST_CLASS_CHECKIN_SPEC.md). Case A (open 24h window —
 * they messaged us recently, usually because Mia booked the class) →
 * free-form composed check-in. Case B (no window — booked via the app
 * or front desk) → ONE approved marketing template, consent-gated.
 * Once ever per contact via contacts.first_class_checkin_at.
 */
export async function runFirstClassCheckins(db, { nowMs = Date.now() } = {}) {
  const results = { freeform: 0, templates: 0, skipped: 0, reasons: {} }
  // Per-tick skip-reason tally — persisted on the cron heartbeat so the
  // settings card can answer "why didn't it send?" without server logs
  // (lesson from the sequence-engine incidents, CHANGELOG #289/#291).
  const bump = (reason) => { results.reasons[reason] = (results.reasons[reason] || 0) + 1 }
  if (!withinDublinDaytime(nowMs)) return { ...results, reason: 'quiet_hours' }

  const { data: locations } = await db.from('locations')
    .select('id, name, settings')
    .eq('active', true)

  for (const location of locations || []) {
    const settings = location?.settings?.customer_agent || null
    const checkin = { ...CHECKIN_DEFAULTS, ...(settings?.first_class_checkin || {}) }
    if (!checkin.enabled) continue
    if (!settings?.enabled && !settings?.test_mode) continue
    // MIA-REVIEW.3 — operator quiet_hours apply to check-ins too.
    const window = proactiveWindowOpen(nowMs, settings)
    if (!window.open) { bump(window.reason); continue }

    const sinceIso = new Date(nowMs - CHECKIN_MAX_AGE_H * H_MS).toISOString()
    // wa_status, NOT opted_out — same phantom-column trap as the followups
    // query above; a select error here must be loud, not an empty tick.
    const { data: contacts, error: contactsError } = await db.from('contacts')
      .select('id, first_name, name, wa_phone, phone, pipeline_stage_slug, last_attended_at, first_class_checkin_at, recent_bookings, wa_status')
      .eq('location_id', location.id)
      .in('pipeline_stage_slug', ['new_lead', 'first_class', 'second_class', 'trial_done'])
      .gte('last_attended_at', sinceIso)
      .is('first_class_checkin_at', null)
      .limit(50)
    if (contactsError) {
      console.error('[radar-agent] checkin candidate query failed:', contactsError.message)
      bump('candidate_query_failed')
      continue
    }

    const branding = await getLocationBranding(db, location.id)
    const knowledge = await loadAgentKnowledge(db, location.id)

    for (const contact of contacts || []) {
      try {
        const decision = classifyCheckinCandidate({
          stage: contact.pipeline_stage_slug,
          lastAttendedAtMs: contact.last_attended_at ? new Date(contact.last_attended_at).getTime() : null,
          checkinSentAt: contact.first_class_checkin_at,
          nowMs,
          delayHours: checkin.delay_hours,
        })
        if (decision.action !== 'checkin') { bump(decision.reason || 'not_eligible'); results.skipped++; continue }

        const to = contact.wa_phone || contact.phone
        if (!to || contact.wa_status === 'opted_out') { bump('no_phone_or_opted_out'); results.skipped++; continue }
        if (!settings?.enabled && settings?.test_mode &&
            !phoneMatchesAllowlist(to, settings?.test_phones)) {
          bump('test_allowlist'); results.skipped++; continue
        }
        if ((await checkinsSentToday(db, location.id, nowMs)) >= checkin.daily_cap) {
          console.warn('[radar-agent] checkin-skip', JSON.stringify({ locationId: location.id, reason: 'daily_cap' }))
          bump('daily_cap')
          break
        }

        const className = attendedClassName(
          contact.recent_bookings, new Date(contact.last_attended_at).getTime(),
        ) || 'first'
        const firstName = (contact.first_name || String(contact.name || '').split(/\s+/)[0] || 'there').trim()

        // Existing conversation? (Case A needs one with a live window.)
        // MIA-REVIEW.3 — the same guards the followup candidate query applies:
        // a sticky operator pause (mig 435 agent_paused_at) deliberately does
        // NOT stamp agent_handed_off_at, and shouldAgentReply's contract is
        // that a paused thread stays FULLY silent. Skipping only on
        // agent_handed_off_at let Mia send a proactive check-in into a thread
        // an operator had explicitly paused or switched off.
        const { data: convRows } = await db.from('whatsapp_conversations')
          .select('id, contact_id, location_id, agent_active, agent_paused_at, agent_handed_off_at')
          .eq('location_id', location.id)
          .eq('contact_id', contact.id)
          .order('last_message_at', { ascending: false })
          .limit(1)
        const existingConv = convRows?.[0] || null
        if (existingConv?.agent_handed_off_at) { bump('handed_off'); results.skipped++; continue }
        if (existingConv?.agent_paused_at) { bump('agent_paused'); results.skipped++; continue }
        if (existingConv && existingConv.agent_active === false) { bump('agent_inactive'); results.skipped++; continue }

        let facts = { rows: [], lastInboundAtMs: null, humanSpokeAfterInbound: false }
        if (existingConv) facts = await lastInboundFacts(db, existingConv.id)
        if (facts.humanSpokeAfterInbound) { bump('human_active'); results.skipped++; continue }
        const windowOpen = facts.lastInboundAtMs && (nowMs - facts.lastInboundAtMs) < 23 * H_MS

        if (windowOpen) {
          // Case A — free-form, in Mia's voice, referencing the class.
          const composed = await composeAgentText({
            location, settings, historyRows: facts.rows,
            instruction: checkinInstruction(className),
            companyName: branding.companyName, knowledge,
          })
          if (composed.error) {
            console.warn('[radar-agent] checkin-skip', JSON.stringify({ contactId: contact.id, reason: composed.error }))
            bump('compose_error'); results.skipped++; continue
          }
          if (isSkipResponse(composed.text)) {
            await stampCheckin(db, contact, location.id, className, 'skipped — already discussed')
            bump('already_discussed'); results.skipped++; continue
          }
          const parsed = parseAgentResponse(composed.text)
          if (parsed.handoff || !parsed.text) { bump('compose_handoff'); results.skipped++; continue }
          const { sendTextMessage } = await import('@/lib/whatsapp')
          const res = await sendTextMessage(to, parsed.text, { locationId: location.id })
          if (!res?.messageId) { bump('send_failed'); results.skipped++; continue }
          await recordProactiveMessage(db, { id: existingConv.id, contact_id: contact.id, location_id: location.id }, {
            body: parsed.text, waMessageId: res.messageId, messageType: 'text',
          })
          await stampCheckin(db, contact, location.id, className, 'in-window')
          results.freeform++
          continue
        }

        // Case B — template (marketing ⇒ marketing consent, like a campaign).
        if (!checkin.template_name) {
          console.warn('[radar-agent] checkin-skip', JSON.stringify({ contactId: contact.id, reason: 'no_template_configured' }))
          bump('no_template_configured'); results.skipped++; continue
        }
        const { data: prefs } = await db.from('contact_preferences')
          .select('whatsapp_marketing')
          .eq('contact_id', contact.id)
          .maybeSingle()
        if (prefs?.whatsapp_marketing !== true) {
          await stampCheckin(db, contact, location.id, className, 'skipped — no marketing consent')
          bump('no_marketing_consent'); results.skipped++; continue
        }
        const { data: tRows } = await db.from('whatsapp_templates')
          .select('name, language, status, components, header_media_url')
          .eq('location_id', location.id)
          .eq('name', checkin.template_name)
          .order('created_at', { ascending: false })
          .limit(1)
        const template = tRows?.[0]
        if (!template || String(template.status || '').toUpperCase() !== 'APPROVED') {
          console.warn('[radar-agent] checkin-skip', JSON.stringify({ contactId: contact.id, reason: 'template_not_approved' }))
          bump('template_not_approved'); results.skipped++; continue
        }
        const { extractTemplateBody } = await import('@/lib/radar-outreach')
        const { sendTemplateMessage, headerComponentFor, getOrCreateConversation } = await import('@/lib/whatsapp')
        const { varCount } = extractTemplateBody(template.components)
        const values = [firstName, className]
        const components = buildFollowupComponents(varCount, values)
        const headerComponent = headerComponentFor(template.components, template.header_media_url)
        if (headerComponent) components.unshift(headerComponent)
        const res = await sendTemplateMessage(to, template.name, template.language || 'en', components, {
          locationId: location.id,
        })
        if (!res?.messageId) { bump('send_failed'); results.skipped++; continue }
        const conversationId = existingConv?.id
          || await getOrCreateConversation(db, { id: contact.id, wa_phone: contact.wa_phone, phone: contact.phone, name: contact.name }, location.id)
        if (conversationId) {
          await recordProactiveMessage(db, { id: conversationId, contact_id: contact.id, location_id: location.id }, {
            body: renderFollowupBody(template, values) || `[Template: ${template.name}]`,
            waMessageId: res.messageId, messageType: 'template', templateName: template.name,
          })
        }
        await stampCheckin(db, contact, location.id, className, 'template')
        results.templates++
      } catch (e) {
        bump('error')
        results.skipped++
        console.error('[radar-agent] checkin error:', e?.message || e)
      }
    }
  }
  return results
}
