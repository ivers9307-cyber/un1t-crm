// MIA-BOARD.4 — the nightly conversation reviewer.
//
// Ten weeks of zero staff ratings (agent_message_feedback: 0 rows ever) was
// the verdict on passive quality collection, so the signal is generated
// instead: every night at 03:00 a rubric reviewer reads yesterday's
// agent-touched conversations and writes one row per conversation to
// agent_conversation_reviews (mig 569) — score 1-5, machine-readable flags,
// a one-line summary, and the worst-moment quote. The analytics page surfaces
// flagged conversations; Mondays, managers get a 7-day digest push.
//
// TZ.5 — "yesterday" and "Monday" are each studio's own (locations.timezone):
// conversations are reviewed per zone, against that zone's yesterday, and the
// digest reaches a studio on its own Monday. An all-Dublin estate runs the one
// Dublin window it always did.
//
// Direct API calls, deliberately NOT the Batch API: at ~3 agent conversations
// a day batching buys nothing (revisit if the line 10x's). Reviews ride the
// same model + thinking config as Mia herself so the reviewer's bar moves
// with the model she runs on.

import { anthropicMessages } from '@/lib/anthropic'
import { dayStrIn, addDaysIn, dayStartMsIn, zoneOfLocation, DEFAULT_TZ } from '@/lib/location-time'
import { logError } from '@/lib/log'
import { selectAll } from '@/lib/select-all'
import { sendPushToRolesAtLocation } from '@/lib/push'
import { MANAGER_ROLES } from '@/lib/schemas'
import { AGENT_MODEL, AGENT_THINKING } from './auto-reply'

const MAX_CONVERSATIONS_PER_RUN = 25
const MAX_TRANSCRIPT_MESSAGES = 40
const MAX_BODY_CHARS = 600
export const FLAGGED_SCORE_THRESHOLD = 2

// The rubric IS the review prompt: every line pins a rule that has failed
// live at least once, with the incident that earned it.
export const REVIEW_RUBRIC = [
  'Never affirm a claim you cannot verify from the tools or knowledge (Priscila: "I can see you\'ve been trying to cancel" with no record).',
  'Never state class capacity counts. Time and name only; at most a coy full/limited.',
  'Never double-confirm an action that already happened, and never say "Done!" for something merely queued for the team.',
  'Offer, trial, discount and entitlement questions are answered only from KNOWLEDGE; a membership status flag is never an eligibility answer (Ciaran: confident wrong "no" to a win-back lead).',
  'Hand off when knowledge does not cover the question instead of improvising.',
  'Tone: low-key, no em dashes, no gush, no emoji pile-ons; mirror the customer\'s language.',
  'Dates and times must be internally coherent (never "your booking is still good to go" about a class that already ran).',
]

/**
 * Yesterday as a full local day in `zone` (the studio's). Pure.
 * @param {number} [nowMs]
 * @param {string} [zone] IANA zone
 * @returns {{reviewDate: string, startIso: string, endIso: string}}
 */
export function reviewWindow(nowMs = Date.now(), zone = DEFAULT_TZ) {
  const today = dayStrIn(nowMs, zone)
  const reviewDate = addDaysIn(today, -1, zone)
  return {
    reviewDate,
    startIso: new Date(dayStartMsIn(reviewDate, zone)).toISOString(),
    endIso: new Date(dayStartMsIn(today, zone)).toISOString(),
  }
}

/**
 * Is it Monday on the studio's clock? Weekday of the LOCAL date key (noon-UTC
 * of the key is safely the same weekday; midnight-UTC would read the day
 * before for a zone east of UTC). Pure.
 */
export function isMondayIn(nowMs, zone = DEFAULT_TZ) {
  return new Date(`${dayStrIn(nowMs, zone)}T12:00:00Z`).getUTCDay() === 1
}

// TZ.5 — every location's zone, read once per run. The candidate query spans
// all studios, so the zones are needed BEFORE it, keyed by id; a location the
// list does not hold (or a NULL location_id) reads as DEFAULT_TZ, the same
// answer getLocationZone gives for a missing row. Paged (the 1k row cap);
// throws on a failed read.
async function readLocationZones(db) {
  const rows = await selectAll((from, to) => db.from('locations').select('id, timezone').order('id').range(from, to))
  return new Map(rows.map((row) => [row.id, zoneOfLocation(row)]))
}

// Distinct zones in first-seen order, DEFAULT_TZ always among them (it owns
// rows whose location has no row). One zone for an all-Dublin estate.
function zoneGroups(zones) {
  const out = []
  for (const z of zones.values()) if (!out.includes(z)) out.push(z)
  if (!out.includes(DEFAULT_TZ)) out.push(DEFAULT_TZ)
  return out
}

/** Speaker-labelled transcript, oldest first. Pure. */
export function buildReviewTranscript(messages) {
  const lines = []
  for (const m of messages || []) {
    const body = String(m?.body || '').trim()
    if (!body) continue
    const clipped = body.length > MAX_BODY_CHARS ? body.slice(0, MAX_BODY_CHARS) + '…' : body
    const speaker = m.direction === 'inbound'
      ? 'CUSTOMER'
      : m.source === 'agent' ? 'MIA' : 'STAFF'
    lines.push(`${speaker}: ${clipped}`)
  }
  return lines.join('\n')
}

/**
 * Tolerant strict-JSON extraction: fences and prose stripped, first {...}
 * parsed, fields coerced to the row shape. Null when nothing parseable —
 * the caller records a skip, never a fabricated review. Pure.
 */
export function parseReviewJson(text) {
  const s = String(text || '')
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  let raw
  try {
    raw = JSON.parse(s.slice(start, end + 1))
  } catch {
    return null
  }
  const scoreNum = Math.round(Number(raw.score))
  return {
    score: Number.isFinite(scoreNum) ? Math.min(5, Math.max(1, scoreNum)) : null,
    flags: Array.isArray(raw.flags)
      ? raw.flags.filter(f => typeof f === 'string' && f.trim()).map(f => f.trim().slice(0, 60)).slice(0, 10)
      : [],
    summary: typeof raw.summary === 'string' ? raw.summary.trim().slice(0, 400) || null : null,
    worst_quote: typeof raw.worst_quote === 'string' ? raw.worst_quote.trim().slice(0, 300) || null : null,
  }
}

// Reasons the decision log uses mechanically; anything else in a 'silent'
// row is a model-written handoff summary — the raw material for the
// handoffs-by-reason surface on analytics.
export const MECHANICAL_SILENCE_REASONS = new Set([
  'handed_off', 'human_owned', 'ignorable_type', 'agent_paused', 'in_flight',
  'model_error', 'model_exception', 'model_refusal', 'model_truncated',
  'tool_error', 'claim_lost', 'quiet_hours', 'disabled', 'test_mode',
  'cap_reached', 'rate_limited', 'window_closed', 'undeliverable', 'blocked',
  'no_reply', 'verify_failed',
])

/** Is this decision-log reason a human-readable handoff summary? Pure. */
export function isHandoffSummaryReason(reason) {
  const r = String(reason || '').trim()
  if (!r) return false
  return !MECHANICAL_SILENCE_REASONS.has(r)
}

function buildReviewRequest(transcript, reviewDate) {
  const system = [
    'You are a strict quality reviewer for Mia, a gym\'s WhatsApp customer agent. Review the conversation below against this rubric:',
    ...REVIEW_RUBRIC.map((r, i) => `${i + 1}. ${r}`),
    '',
    'Score the AGENT\'s performance 1-5 (5 = flawless; 2 or lower = a human should read this thread). Only judge MIA lines — customers and staff are context.',
    'Reply with STRICT JSON only, no prose, exactly this shape:',
    '{"score": <1-5>, "flags": ["<snake_case_rubric_breach>", ...], "summary": "<one line>", "worst_quote": "<the single worst agent line, verbatim, or null>"}',
  ].join('\n')
  return {
    model: AGENT_MODEL,
    max_tokens: 500,
    thinking: AGENT_THINKING,
    output_config: { effort: 'low' },
    system,
    messages: [{ role: 'user', content: `TRANSCRIPT (${reviewDate}):\n${transcript}` }],
  }
}

const CHANNELS = [
  { name: 'whatsapp', messagesTable: 'whatsapp_messages' },
  { name: 'instagram', messagesTable: 'instagram_messages' },
]

/**
 * One nightly run: review yesterday's agent-touched conversations, once each
 * (unique (channel, conversation_id, review_date) makes reruns idempotent).
 * Never throws.
 */
export async function runAgentReview(db, { nowMs = Date.now() } = {}) {
  const results = { reviewed: 0, flagged: 0, skipped: 0 }
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return { ...results, error: 'no_api_key' }

  // TZ.5 — a failed zone read is a DB outage: skip the run (reruns are
  // idempotent; tomorrow's run reviews tomorrow's yesterday), never a guess.
  let zones
  try {
    zones = await readLocationZones(db)
  } catch (e) {
    logError('agent-review', 'location zones unreadable; run skipped', { err: e })
    return { ...results, error: 'zone_read_failed' }
  }
  const zoneOf = (locationId) => zones.get(locationId) ?? DEFAULT_TZ

  for (const channel of CHANNELS) {
    for (const zone of zoneGroups(zones)) {
      const { reviewDate, startIso, endIso } = reviewWindow(nowMs, zone)
      // Conversations Mia touched in this zone's window (rows of studios in
      // another zone are theirs to review against their own day).
      const { data: touched, error } = await db.from(channel.messagesTable)
        .select('conversation_id, location_id')
        .eq('source', 'agent')
        .gte('created_at', startIso)
        .lt('created_at', endIso)
        .limit(500)
      if (error) {
        console.error(`[agent-review] candidate query failed (${channel.name}):`, error.message)
        continue
      }
      const byConversation = new Map()
      for (const row of touched || []) {
        if (row.conversation_id && zoneOf(row.location_id) === zone) byConversation.set(row.conversation_id, row.location_id)
      }
      if (!byConversation.size) continue

      // Idempotence: skip conversations already reviewed for this date.
      const ids = [...byConversation.keys()]
      const { data: existing } = await db.from('agent_conversation_reviews')
        .select('conversation_id')
        .eq('channel', channel.name)
        .eq('review_date', reviewDate)
        .in('conversation_id', ids)
      const done = new Set((existing || []).map(r => r.conversation_id))

      for (const [conversationId, locationId] of byConversation) {
        if (done.has(conversationId)) { results.skipped++; continue }
        if (results.reviewed >= MAX_CONVERSATIONS_PER_RUN) {
          console.warn(`[agent-review] per-run cap (${MAX_CONVERSATIONS_PER_RUN}) reached — remainder picks up tomorrow`)
          break
        }
        try {
          const { data: rows } = await db.from(channel.messagesTable)
            .select('direction, source, sent_by, body, created_at')
            .eq('conversation_id', conversationId)
            .lt('created_at', endIso)
            .order('created_at', { ascending: false })
            .limit(MAX_TRANSCRIPT_MESSAGES)
          const transcript = buildReviewTranscript((rows || []).reverse())
          if (!transcript) { results.skipped++; continue }

          const { res, data } = await anthropicMessages(
            buildReviewRequest(transcript, reviewDate),
            { apiKey, locationId, source: 'agent_review' },
          )
          if (!res.ok) { results.skipped++; continue }
          const text = (data?.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n')
          const review = parseReviewJson(text)
          if (!review || !review.score) { results.skipped++; continue }

          const { error: insertError } = await db.from('agent_conversation_reviews').insert({
            location_id: locationId,
            channel: channel.name,
            conversation_id: conversationId,
            review_date: reviewDate,
            score: review.score,
            flags: review.flags,
            summary: review.summary,
            worst_quote: review.worst_quote,
            model: AGENT_MODEL,
          })
          if (insertError) { results.skipped++; continue } // unique race = already done
          results.reviewed++
          if (review.score <= FLAGGED_SCORE_THRESHOLD || review.flags.length) results.flagged++
        } catch (e) {
          results.skipped++
          console.error(`[agent-review] review error (${channel.name}):`, e?.message || e)
        }
      }
    }
  }

  // Monday digest — the week in one push, per location with anything flagged.
  try {
    // TZ.5 — each studio's own Monday (isMondayIn). The read runs when it is
    // Monday for at least one zone; for an all-Dublin estate, exactly as before.
    if (zoneGroups(zones).some((z) => isMondayIn(nowMs, z))) {
      const weekAgoIso = new Date(nowMs - 7 * 86_400_000).toISOString()
      const { data: recent } = await db.from('agent_conversation_reviews')
        .select('location_id, score, flags')
        .gte('created_at', weekAgoIso)
        .limit(500)
      const byLocation = new Map()
      for (const r of recent || []) {
        const s = byLocation.get(r.location_id) || { total: 0, flagged: 0 }
        s.total++
        if ((r.score || 5) <= FLAGGED_SCORE_THRESHOLD || (r.flags || []).length) s.flagged++
        byLocation.set(r.location_id, s)
      }
      for (const [locationId, s] of byLocation) {
        if (!s.flagged) continue
        if (!isMondayIn(nowMs, zoneOf(locationId))) continue
        await sendPushToRolesAtLocation(locationId, MANAGER_ROLES, {
          title: 'Mia weekly review',
          body: `${s.flagged} of ${s.total} agent conversations were flagged this week. The list is on the agent analytics page.`,
          data: { type: 'agent_review_digest' },
        })
      }
    }
  } catch (e) {
    console.error('[agent-review] digest failed:', e?.message || e)
  }

  return results
}
