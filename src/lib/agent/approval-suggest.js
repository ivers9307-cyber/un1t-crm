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
import { instantToZonedParts, zoneOfLocation } from '@/lib/location-time'
import { providerFor } from '@/lib/membership/source'
import { noneSource } from '@/lib/membership/sources/none'
import { providerTakesBookings } from './tool-capability'
import { anthropicMessages } from '@/lib/anthropic'
import { resolveAgentSettings } from './settings-resolve'
import { chunkIds } from '@/lib/person-accounts'
import { logWarn } from '@/lib/log'

// MIA-SONNET5 — in step with the inbound reply path (see auto-reply.js).
const AGENT_MODEL = 'claude-sonnet-5'

const KIND_LABELS = {
  pause: 'pause their membership',
  cancellation: 'cancel their membership',
  class_booking: 'book a class',
  class_cancellation: 'cancel a class booking',
  event_booking: 'book an event',
  event_cancellation: 'cancel an event booking',
  event_move: 'move an event entry to another date',
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

const WD = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/**
 * TZ.17 — "today" for the prompt, in Date#toDateString's exact shape
 * ('Sun Oct 11 2026') but on the studio's calendar. It was the host clock's
 * (`new Date().toDateString()`, UTC on Vercel), so from 00:00 to 01:00 Irish
 * summer time Mia was told it was still yesterday.
 * @param {number} nowMs
 * @param {string} zone IANA zone
 */
export function zonedDateString(nowMs, zone) {
  const p = instantToZonedParts(nowMs, zone)
  return `${WD[p.weekday - 1]} ${MON[p.mo - 1]} ${String(p.d).padStart(2, '0')} ${String(p.y).padStart(4, '0')}`
}

// One short proactive message in Mia's voice, given the thread + an
// instruction. Mirrors followups.js composeAgentText verbatim (same
// model/max_tokens/system-cache shape) — see file header. Returns
// { text } or { error }; never throws.
// Exported for tests (repo convention) — see compose-effort.test.js.
// MIAORG.1 Task 6 (T6-D) — `capability` is what the prompt may offer at this
// studio: { bookings, bookingUrl }. Absent or bookings true is the Glofox
// render, byte-identical to before (the link is ignored).
export async function composeAgentText(location, settings, historyRows, instruction, companyName, signal, membershipSource = null, { bookings = true, bookingUrl = null } = {}) {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return { error: 'no_api_key' }
  const system = buildCachedSystem({
    businessName: companyName,
    locationName: location.name,
    agentName: settings?.agent_name || null,
    membershipUrl: settings?.membership_signup_url || null,
    membershipSource, // W1.M3b — null renders the Glofox default
    bookings,
    bookingUrl: bookings ? null : bookingUrl,
    tone: settings?.tone || null,
    extraRules: settings?.extra_rules || null,
    today: zonedDateString(Date.now(), zoneOfLocation(location)),
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

// MIAHATCH.5 Task 18 — the context for a un1t.online card (details.provider):
// the member's membership and next booked class at the card's studio, from
// the un1t_* mirror through slice 1's shapers. No live un1t.online call on the
// suggest path, and never Glofox's columns (glofox_membership_state,
// recent_bookings), which say nothing about a un1t.online member. Best-effort
// like the rest of this module: an unreadable mirror leaves the line out.
const UN1T_SUGGEST_BOOKINGS = 200

async function un1tCardContext(db, row, zone) {
  const out = {}
  const { data: contact, error: cErr } = await db.from('contacts')
    .select('name, first_name, un1t_user_id')
    .eq('id', row.contact_id)
    .maybeSingle()
  if (cErr || !contact) return out
  out.firstName = contact.first_name || (contact.name ? contact.name.split(' ')[0] : null)
  const un1tUserId = idText(row.details?.un1t_user_id) || idText(contact.un1t_user_id)
  if (!un1tUserId) return out
  const { shapeUn1tMembership, shapeUn1tBookingsForAgent, UN1T_BOOKED_STATUS } = await import('./un1t-tools')
  const nowMs = Date.now()

  const { data: subs, error: sErr } = await db.from('un1t_subscriptions')
    .select('status, product_id, product_title, price_cents, currency, billing_interval, billing_interval_count, current_period_end, cancel_at_period_end, paused_at, paused_until, past_due_at')
    .eq('location_id', row.location_id)
    .eq('un1t_user_id', un1tUserId)
    .order('un1t_id')
  if (sErr) {
    logWarn('mia-un1t', 'suggest membership read failed', { locationId: row.location_id, op: 'suggest_membership', status: null, code: sErr.code ?? null })
  } else {
    const m = shapeUn1tMembership({ subscriptions: subs || [], client: null, creditsCapable: false, zone, nowMs })
    // The mirror runs minutes behind: "none" is never stated as a fact.
    if (m.status !== 'none') out.membershipStatus = m.plan ? `${m.status} (${m.plan})` : m.status
  }

  // The most recently made bookings hold the upcoming ones; the events read
  // keeps only classes still to come.
  const { data: bookings, error: bErr } = await db.from('un1t_bookings')
    .select('un1t_id, event_id, status')
    .eq('location_id', row.location_id)
    .eq('un1t_user_id', un1tUserId)
    .eq('status', UN1T_BOOKED_STATUS)
    .order('remote_created_at', { ascending: false, nullsFirst: false })
    .limit(UN1T_SUGGEST_BOOKINGS)
  if (bErr) {
    logWarn('mia-un1t', 'suggest bookings read failed', { locationId: row.location_id, op: 'suggest_bookings', status: null, code: bErr.code ?? null })
    return out
  }
  const eventIds = [...new Set((bookings || []).map((b) => idText(b.event_id)).filter(Boolean))]
  const byId = new Map()
  for (const batch of chunkIds(eventIds)) {
    const { data: events, error: eErr } = await db.from('un1t_events')
      .select('un1t_id, title, starts_at, status')
      .eq('location_id', row.location_id)
      .in('un1t_id', batch)
      .gte('starts_at', new Date(nowMs).toISOString())
    if (eErr) {
      logWarn('mia-un1t', 'suggest events read failed', { locationId: row.location_id, op: 'suggest_events', status: null, code: eErr.code ?? null })
      return out
    }
    for (const e of events || []) byId.set(String(e.un1t_id), e)
  }
  const next = shapeUn1tBookingsForAgent(bookings || [], byId, nowMs, zone)[0]
  if (next) {
    out.nextClassName = next.class_name
    out.nextClassTime = next.starts_at
  }
  return out
}

const idText = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null)

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
  // UN1TWRITE.8 — a refund_request is record-only and Mia's refund_request_text
  // already answered the customer; a "Mia suggests" draft would be a second,
  // unrequested word about money. Nothing is read and no model is called.
  if (row?.kind === 'refund_request') return { error: 'no_suggestion_for_kind' }
  const messagesTable = MESSAGES_TABLE_BY_CHANNEL[row?.channel]
  if (!messagesTable) return { error: 'unknown_channel' }
  if (!row?.location_id) return { error: 'no_location' }

  // MIAORG.1 — Mia's settings resolved DEFAULTS <- org <- studio. An
  // unreadable or missing studio is location_not_found, as it always was.
  const resolved = await resolveAgentSettings(db, row.location_id)
  if (!resolved.ok) return { error: 'location_not_found' }
  const location = resolved.location
  const settings = resolved.settings

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
  if (row.contact_id && row.details?.provider === 'un1t_online') {
    Object.assign(ctx, await un1tCardContext(db, row, zoneOfLocation(location)))
  } else if (row.contact_id) {
    const { data: contact } = await db.from('contacts')
      .select('name, first_name, pipeline_stage_slug, glofox_membership_state, glofox_membership_plan, recent_bookings')
      .eq('id', row.contact_id)
      .maybeSingle()
    if (contact) {
      ctx.firstName = contact.first_name || (contact.name ? contact.name.split(' ')[0] : null)
      ctx.membershipStatus = contact.glofox_membership_state || null
      // TZ.17 — the class time on the studio's clock (it was the default zone).
      const next = formatNextClass(contact.recent_bookings, new Date(), zoneOfLocation(location))
      if (next.found) {
        ctx.nextClassName = next.class_name
        ctx.nextClassTime = next.class_time
      }
    }
  }

  const instruction = buildSuggestionInstruction(row.kind, row.status, ctx)
  const branding = await getLocationBranding(db, location.id)
  // W1.M3b / MIAORG.1 Task 6 (T6-D) — the provider comes off the location row
  // the resolver already read (locations.membership_source), the same way the
  // reply path derives it; no second read that could fail on its own.
  const provider = location?.membership_source ? providerFor(location.membership_source) : noneSource
  const bookings = providerTakesBookings(provider)
  const composed = await composeAgentText(
    location, settings, historyRows, instruction, branding.companyName, signal,
    { key: provider.key, label: provider.label },
    { bookings, bookingUrl: bookings ? null : (settings?.booking_url || null) },
  )
  if (composed.error) return { error: composed.error }

  const text = sanitizeSuggestion(composed.text)
  if (!text) return { error: 'empty_or_skip' }
  return { text }
}
