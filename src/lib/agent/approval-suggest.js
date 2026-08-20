// INBOX-APPROVALS-AI.1 — Wave 3: after staff decide a queued agent
// request (approve/decline/save), an async Mia call proposes ONE
// bespoke follow-up message to the customer. Click-to-prefill only —
// never auto-sent, never auto-prefilled (see the route + card for the
// gating). Silent degradation throughout: any model failure returns
// { error } and the caller renders nothing.
//
// Mirrors the composeAgentText call shape in followups.js verbatim
// (same model const, max_tokens, buildCachedSystem, {error}|{text}
// return) — see followups.js:266-303. Not re-exported from there
// because that fn is followups-scoped (NUDGE_INSTRUCTION baked into
// its call sites' expectations); duplicating the ~35-line fetch here
// keeps this module ownership-independent, per the plan's note that
// mirroring beyond ~30 lines should be flagged — see report.

import { buildCachedSystem, SKIP_PREFIX } from './prompt'
import { formatHistoryForClaude, isSkipResponse, parseAgentResponse } from './core'
import { formatNextClass } from './account-tools'
import { getLocationBranding } from '@/lib/location-branding'
import { anthropicMessages } from '@/lib/anthropic'

// MIA-SONNET5 — in step with the inbound reply path (see auto-reply.js).
const AGENT_MODEL = 'claude-sonnet-5'

const KIND_LABELS = {
  pause: 'pause their membership',
  cancellation: 'cancel their membership',
  class_booking: 'book a class',
  class_cancellation: 'cancel a class booking',
  event_booking: 'book an event',
  event_cancellation: 'cancel an event booking',
}

const OUTCOME_LABELS = {
  approved: 'approved',
  declined: 'declined',
  saved: 'kept them as a member (declined the cancellation)',
  actioned: 'actioned',
  failed: 'attempted but it failed on our side',
}

/**
 * Compose the instruction Mia sees for a Wave-3 suggestion — tells her
 * what the staff member just decided and asks for ONE short warm
 * first-person follow-up to the customer. Pure, unit-tested.
 * @param {string} kind    agent_membership_requests.kind
 * @param {string} outcome the decided status ('approved'|'declined'|'saved'|'actioned'|'failed')
 * @param {object} ctx     { reason, firstName, membershipStatus, nextClassName, nextClassTime }
 * @returns {string}
 */
export function buildSuggestionInstruction(kind, outcome, ctx = {}) {
  const action = KIND_LABELS[kind] || kind || 'their request'
  const outcomeText = OUTCOME_LABELS[outcome] || outcome || 'decided'
  const lines = [
    '[STUDIO SYSTEM - not the customer] A staff member just reviewed this customer\'s ' +
      `request to ${action}, and the decision was: ${outcomeText}.`,
  ]
  if (ctx.reason) lines.push(`Their stated reason: "${ctx.reason}".`)
  if (ctx.firstName) lines.push(`Their first name is ${ctx.firstName}.`)
  if (ctx.membershipStatus) lines.push(`Their membership is currently: ${ctx.membershipStatus}.`)
  if (ctx.nextClassName) {
    const when = ctx.nextClassTime ? ` on ${ctx.nextClassTime}` : ''
    lines.push(`Their next booked class is ${ctx.nextClassName}${when}.`)
  }
  lines.push(
    'Write ONE short, warm follow-up message to the customer in your own voice, first ' +
      'person, ≤2 sentences, that lets them know where things stand and closes the loop ' +
      'naturally. No placeholders or brackets, no re-introducing yourself. If there is ' +
      `genuinely nothing useful to say, reply with exactly ${SKIP_PREFIX} and nothing else.`,
  )
  return lines.join(' ')
}

/**
 * Clean up the model's raw suggestion text. Pure, unit-tested.
 * Returns null for anything unusable (empty, [[SKIP]], a handoff, whitespace-only).
 *
 * Staff click this straight into the composer and usually send it unedited, so
 * it gets the SAME deterministic treatment as a live reply: parseAgentResponse
 * scrubs em dashes (the prompt rule alone isn't reliable — core.js) and strips
 * the control sentinels, and a [[HANDOFF]] suggestion has nothing to prefill.
 * @param {string} text
 * @returns {string|null}
 */
export function sanitizeSuggestion(text) {
  if (!text || typeof text !== 'string') return null
  if (!text.trim()) return null
  if (isSkipResponse(text)) return null

  const parsed = parseAgentResponse(text)
  if (parsed.action !== 'reply' || !parsed.text) return null
  let s = parsed.text

  // Strip a single pair of surrounding quotes (straight or curly) if the
  // WHOLE message is quoted — the model sometimes wraps its reply.
  const quotePairs = [['"', '"'], ["'", "'"], ['“', '”'], ['‘', '’']]
  for (const [open, close] of quotePairs) {
    if (s.length >= 2 && s.startsWith(open) && s.endsWith(close)) {
      s = s.slice(1, -1).trim()
      break
    }
  }
  if (!s) return null

  if (s.length > 500) {
    const cut = s.slice(0, 500)
    const lastSpace = cut.lastIndexOf(' ')
    s = (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trim()
  }
  return s || null
}

// One short proactive message in Mia's voice, given the thread + an
// instruction. Mirrors followups.js composeAgentText verbatim (same
// model/max_tokens/system-cache shape) — see file header. Returns
// { text } or { error }; never throws.
// Exported for tests (repo convention) — see compose-effort.test.js.
export async function composeAgentText(location, settings, historyRows, instruction, companyName, signal) {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return { error: 'no_api_key' }
  const system = buildCachedSystem({
    businessName: companyName || 'UN1T',
    locationName: location.name,
    agentName: settings?.agent_name || null,
    membershipUrl: settings?.membership_signup_url || null,
    tone: settings?.tone || null,
    extraRules: settings?.extra_rules || null,
    today: new Date().toDateString(),
  })
  const messages = [
    ...formatHistoryForClaude(historyRows || []),
    { role: 'user', content: instruction },
  ]
  try {
    // SAAS4-M1 — metered via the shared wrapper (source: approval_suggest).
    const { res, data: body } = await anthropicMessages(
      // MIA-HYGIENE.2 — effort `low`, same reasoning as the followups path.
      // MIA-SONNET5 — 300 → 600 for the same tokenizer + adaptive-thinking
      // headroom reason.
      { model: AGENT_MODEL, max_tokens: 600, thinking: { type: 'adaptive' }, output_config: { effort: 'low' }, system, messages },
      { apiKey, locationId: location.id, source: 'approval_suggest', signal }
    )
    if (!res.ok) return { error: `model_http_${res.status}` }
    const text = (body?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim()
    return { text }
  } catch (e) {
    return { error: `model_error:${e?.message || e}` }
  }
}

const MESSAGES_TABLE_BY_CHANNEL = {
  whatsapp: 'whatsapp_messages',
  instagram: 'instagram_messages',
}

/**
 * Compose Mia's Wave-3 post-decision suggestion for one decided
 * agent_membership_requests row. Orchestration — not unit-tested
 * (house convention: no DB tests; route-level care covers this).
 * @param {object} db   supabase-js service-role client
 * @param {object} row  the agent_membership_requests row (post-decision):
 *   id, location_id, kind, status, decision_note, contact_id, channel, conversation_id
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<{ text: string }|{ error: string }>}
 */
export async function composeApprovalSuggestion(db, row, { signal } = {}) {
  const messagesTable = MESSAGES_TABLE_BY_CHANNEL[row?.channel]
  if (!messagesTable) return { error: 'unknown_channel' }
  if (!row?.location_id) return { error: 'no_location' }

  const { data: location } = await db.from('locations')
    .select('id, name, settings')
    .eq('id', row.location_id)
    .maybeSingle()
  if (!location) return { error: 'location_not_found' }

  const settings = location.settings?.customer_agent || null

  let historyRows = []
  if (row.conversation_id) {
    const { data } = await db.from(messagesTable)
      .select('direction, body, message_type, created_at')
      .eq('conversation_id', row.conversation_id)
      .order('created_at', { ascending: false })
      .limit(15)
    historyRows = (data || []).slice().reverse()
  }

  const ctx = { reason: row.decision_note || null }
  if (row.contact_id) {
    const { data: contact } = await db.from('contacts')
      .select('name, first_name, pipeline_stage_slug, glofox_membership_state, glofox_membership_plan, recent_bookings')
      .eq('id', row.contact_id)
      .maybeSingle()
    if (contact) {
      ctx.firstName = contact.first_name || (contact.name ? contact.name.split(' ')[0] : null)
      ctx.membershipStatus = contact.glofox_membership_state || null
      const next = formatNextClass(contact.recent_bookings)
      if (next.found) {
        ctx.nextClassName = next.class_name
        ctx.nextClassTime = next.class_time
      }
    }
  }

  const instruction = buildSuggestionInstruction(row.kind, row.status, ctx)
  const branding = await getLocationBranding(db, location.id)
  const composed = await composeAgentText(location, settings, historyRows, instruction, branding.companyName, signal)
  if (composed.error) return { error: composed.error }

  const text = sanitizeSuggestion(composed.text)
  if (!text) return { error: 'empty_or_skip' }
  return { text }
}
