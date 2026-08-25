// AGENT-HANDOFF-SLA.1 — escalate handoffs nobody picked up.
//
// "Passing you to a UN1T team member now" must not be a black hole: a
// live lead (Kevin, 2026-07-03) waited 23 HOURS after Mia handed off
// before a human replied. The original handoff push fires once and is
// easy to miss (and staff push is dark on Android today), so this sweep
// — riding the same 15-min agent-followups cron — re-alerts managers
// for every handed-off conversation that has had NO human reply and NO
// resolve within the SLA window, once per handoff
// (handoff_escalated_at stamps it).
//
// Human-touch signals, per channel:
//   WhatsApp — an outbound row with sent_by set (operator send routes
//     stamp the sender; agent + sequence/automation sends don't), or
//     resolved_at after the handoff.
//   Instagram — any outbound row with source != 'agent' (IG has no
//     sequence traffic), or resolved_at after the handoff.
// A conversation the cooldown already re-armed (agent_active back to
// true / stamp cleared) simply drops out of the candidate query.
//
// MIA-REVIEW.3 — "once per handoff" is now true. handoff_escalated_at was
// written here and cleared NOWHERE, so a conversation (one per contact per
// channel, long-lived) could only ever escalate once in its lifetime; every
// later handoff on that thread could breach silently forever. It is now
// cleared wherever the handoff resolves: the cooldown re-arm and the operator
// resolve (core.resolveRearmPatch), and it is reset when handoff() stamps a
// NEW agent_handed_off_at.

import { sendPushToRolesAtLocation } from '@/lib/push'
import { MANAGER_ROLES } from '@/lib/schemas'
import { resolveRearmPatch } from './core'

export const HANDOFF_SLA_DEFAULT_MINUTES = 60
const MIN_MS = 60_000
// The manual-takeover patch stamps agent_handed_off_at in the same request
// as the operator's own message — tolerate small write-order skew so their
// message counts as the human reply it is.
const TAKEOVER_SKEW_MS = 5_000

/** Resolve the per-location SLA in minutes (0/negative disables). Pure. */
export function resolveHandoffSlaMinutes(settings) {
  const raw = Number(settings?.handoff_sla_minutes)
  if (!Number.isFinite(raw)) return HANDOFF_SLA_DEFAULT_MINUTES
  return raw > 0 ? Math.round(raw) : 0
}

/**
 * Should this location be swept at all, and with what SLA? Pure.
 *
 * MIA-REVIEW.3 — deliberately NOT gated on the agent being ENABLED any more.
 * Conversations handed off while Mia was live still have customers waiting for
 * a human, and `enabled=false` is the documented panic response to an agent
 * incident — so the operator action most likely to coincide with a pile of
 * unattended handoffs used to silence the escalation built for exactly them.
 *
 * The gate is now: the location has a customer_agent config at all (a studio
 * that never set Mia up has no Mia handoffs to chase) AND the SLA is not
 * disabled. Manual operator takeovers also stamp agent_handed_off_at, but they
 * never escalate: the operator's own message is the human reply
 * (classifyHandoffBreach + TAKEOVER_SKEW_MS).
 *
 * @returns {{ sweep: boolean, reason?: string, slaMinutes?: number }}
 */
export function shouldSweepLocation(settings) {
  if (!settings) return { sweep: false, reason: 'no_agent_config' }
  const slaMinutes = resolveHandoffSlaMinutes(settings)
  if (!slaMinutes) return { sweep: false, reason: 'sla_disabled' }
  return { sweep: true, slaMinutes }
}

/**
 * Is this handed-off conversation an unattended SLA breach? Pure.
 * @returns {{ breach: boolean, reason?: string }}
 */
export function classifyHandoffBreach({
  handedOffAtMs,
  escalatedAt,
  resolvedAtMs,
  humanRepliedAtMs,
  nowMs,
  slaMinutes = HANDOFF_SLA_DEFAULT_MINUTES,
} = {}) {
  if (!slaMinutes) return { breach: false, reason: 'sla_disabled' }
  if (!handedOffAtMs) return { breach: false, reason: 'not_handed_off' }
  if (escalatedAt) return { breach: false, reason: 'already_escalated' }
  if (nowMs - handedOffAtMs < slaMinutes * MIN_MS) return { breach: false, reason: 'within_sla' }
  if (resolvedAtMs && resolvedAtMs >= handedOffAtMs) return { breach: false, reason: 'resolved' }
  if (humanRepliedAtMs && humanRepliedAtMs >= handedOffAtMs - TAKEOVER_SKEW_MS) {
    return { breach: false, reason: 'human_replied' }
  }
  return { breach: true }
}

/** Waiting-time label for the push body, e.g. "1h 15m". Pure. */
export function waitingLabel(handedOffAtMs, nowMs) {
  const mins = Math.max(1, Math.floor((nowMs - handedOffAtMs) / MIN_MS))
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return h ? `${h}h${m ? ` ${m}m` : ''}` : `${m}m`
}

// ── MIA-BOARD.1 — handoff AUTO-RESOLVE ──────────────────────────────────────
//
// The workflow this file escalates for was never completed by anyone: 121
// handed-off threads, ZERO inbox resolves ever (re-audit 2026-08-25). Pushing
// harder at a step nobody takes is noise, so the queue now cleans itself:
//   (a) a human replied since the handoff and the thread has been quiet for
//       auto_resolve_after_reply_hours (default 8 — Richard, 2026-08-20): the
//       human engagement ran its course; hand the thread back to Mia.
//   (b) NOTHING has happened for auto_resolve_stale_hours (default 48): the
//       conversation is over; a parked thread only means the customer's NEXT
//       message lands in silence.
// Either case applies exactly the patch the inbox Resolve button applies
// (resolved_at + resolveRearmPatch), so the SLA escalation stamp clears and
// re-arm semantics are identical to the manual workflow. Operator-paused
// threads (agent_paused_at) are never touched — a sticky pause is an explicit
// "Mia stays out of this one".

export const AUTO_RESOLVE_AFTER_REPLY_HOURS_DEFAULT = 8
export const AUTO_RESOLVE_STALE_HOURS_DEFAULT = 48
const HOUR_MS = 3_600_000

/**
 * Per-location auto-resolve windows, clamped. 0 disables a case; junk falls
 * back to the default (matching resolveHandoffSlaMinutes' posture). Pure.
 */
export function resolveAutoResolveHours(settings) {
  const read = (raw, fallback) => {
    const n = Number(raw)
    if (!Number.isFinite(n)) return fallback
    return n > 0 ? Math.round(n) : 0
  }
  return {
    afterReplyHours: read(settings?.auto_resolve_after_reply_hours, AUTO_RESOLVE_AFTER_REPLY_HOURS_DEFAULT),
    staleHours: read(settings?.auto_resolve_stale_hours, AUTO_RESOLVE_STALE_HOURS_DEFAULT),
  }
}

/**
 * Should this handed-off conversation auto-resolve? Pure.
 * @returns {{ resolve: boolean, reason: string }}
 */
export function classifyAutoResolve({
  handedOffAtMs,
  pausedAt,
  agentActive,
  resolvedAtMs,
  lastMessageAtMs,
  humanRepliedAtMs,
  nowMs,
  afterReplyHours = AUTO_RESOLVE_AFTER_REPLY_HOURS_DEFAULT,
  staleHours = AUTO_RESOLVE_STALE_HOURS_DEFAULT,
} = {}) {
  if (!handedOffAtMs) return { resolve: false, reason: 'not_handed_off' }
  if (pausedAt) return { resolve: false, reason: 'paused' }
  if (agentActive) return { resolve: false, reason: 'already_armed' }
  if (resolvedAtMs && resolvedAtMs >= handedOffAtMs) return { resolve: false, reason: 'already_resolved' }

  // "Quiet" is measured from the last activity of ANY kind; a thread with no
  // messages at all measures from the handoff itself.
  const quietSinceMs = lastMessageAtMs || handedOffAtMs
  const humanReplied = humanRepliedAtMs && humanRepliedAtMs >= handedOffAtMs - TAKEOVER_SKEW_MS

  if (afterReplyHours > 0 && humanReplied && nowMs - quietSinceMs >= afterReplyHours * HOUR_MS) {
    return { resolve: true, reason: 'human_replied_quiet' }
  }
  if (staleHours > 0 && nowMs - quietSinceMs >= staleHours * HOUR_MS) {
    return { resolve: true, reason: 'stale' }
  }
  return { resolve: false, reason: 'waiting' }
}

/**
 * One cron tick: hand parked threads back to Mia. Silent by design — no push,
 * no customer message; the thread simply becomes answerable again. Never
 * throws. First real run drains the accumulated backlog; that is the point.
 */
export async function runHandoffAutoResolve(db, { nowMs = Date.now() } = {}) {
  const results = { resolved: 0, skipped: 0 }
  const nowIso = new Date(nowMs).toISOString()

  const { data: locations } = await db.from('locations')
    .select('id, name, settings')
    .eq('active', true)

  for (const location of locations || []) {
    const settings = location?.settings?.customer_agent || null
    if (!settings) continue
    const { afterReplyHours, staleHours } = resolveAutoResolveHours(settings)
    if (!afterReplyHours && !staleHours) continue

    for (const channel of CHANNELS) {
      // agent_paused_at is WhatsApp-only (mig 435) — same conditional select
      // as humanTookOverDuringTurn.
      const cols = channel.name === 'whatsapp'
        ? 'id, agent_active, agent_handed_off_at, agent_paused_at, resolved_at, last_message_at'
        : 'id, agent_active, agent_handed_off_at, resolved_at, last_message_at'
      const { data: convs, error } = await db.from(channel.conversationsTable)
        .select(cols)
        .eq('location_id', location.id)
        .eq('agent_active', false)
        .not('agent_handed_off_at', 'is', null)
        .order('agent_handed_off_at', { ascending: true })
        .limit(200)
      if (error) {
        console.error(`[radar-agent] auto-resolve candidate query failed (${channel.name}):`, error.message)
        continue
      }

      for (const c of convs || []) {
        try {
          const handedOffAtMs = new Date(c.agent_handed_off_at).getTime()
          const decision = classifyAutoResolve({
            handedOffAtMs,
            pausedAt: c.agent_paused_at || null,
            agentActive: c.agent_active === true,
            resolvedAtMs: c.resolved_at ? new Date(c.resolved_at).getTime() : null,
            lastMessageAtMs: c.last_message_at ? new Date(c.last_message_at).getTime() : null,
            humanRepliedAtMs: await humanRepliedAtMs(db, channel, c.id, handedOffAtMs),
            nowMs,
            afterReplyHours,
            staleHours,
          })
          if (!decision.resolve) { results.skipped++; continue }

          await db.from(channel.conversationsTable)
            .update({
              resolved_at: nowIso,
              ...resolveRearmPatch({ resolved: true, agent_handed_off_at: c.agent_handed_off_at }),
            })
            .eq('id', c.id)

          console.warn('[radar-agent] handoff auto-resolved', JSON.stringify({
            channel: channel.name, conversationId: c.id, reason: decision.reason,
          }))
          results.resolved++
        } catch (e) {
          results.skipped++
          console.error(`[radar-agent] auto-resolve error (${channel.name}):`, e?.message || e)
        }
      }
    }
  }
  return results
}

const CHANNELS = [
  {
    name: 'whatsapp',
    label: 'WhatsApp',
    conversationsTable: 'whatsapp_conversations',
    messagesTable: 'whatsapp_messages',
    pushCategory: 'whatsapp',
    handoffType: 'whatsapp_agent_handoff',
    // Operator send routes stamp sent_by; agent/sequence sends leave it null.
    humanFilter: (q) => q.not('sent_by', 'is', null),
  },
  {
    name: 'instagram',
    label: 'Instagram',
    conversationsTable: 'instagram_conversations',
    messagesTable: 'instagram_messages',
    pushCategory: 'instagram',
    handoffType: 'instagram_agent_handoff',
    humanFilter: (q) => q.neq('source', 'agent'),
  },
]

async function humanRepliedAtMs(db, channel, conversationId, handedOffAtMs) {
  const sinceIso = new Date(handedOffAtMs - TAKEOVER_SKEW_MS).toISOString()
  let q = db.from(channel.messagesTable)
    .select('created_at')
    .eq('conversation_id', conversationId)
    .eq('direction', 'outbound')
    .gte('created_at', sinceIso)
    .order('created_at', { ascending: true })
    .limit(1)
  q = channel.humanFilter(q)
  const { data } = await q
  const row = Array.isArray(data) ? data[0] : null
  return row ? new Date(row.created_at).getTime() : null
}

/**
 * One cron tick: escalate every handed-off, unattended, past-SLA
 * conversation exactly once. Never throws.
 */
export async function runHandoffSlaSweep(db, { nowMs = Date.now() } = {}) {
  const results = { escalated: 0, skipped: 0 }

  const { data: locations } = await db.from('locations')
    .select('id, name, settings')
    .eq('active', true)

  for (const location of locations || []) {
    const settings = location?.settings?.customer_agent || null
    const gate = shouldSweepLocation(settings)
    if (!gate.sweep) continue
    const slaMinutes = gate.slaMinutes
    const cutoffIso = new Date(nowMs - slaMinutes * MIN_MS).toISOString()

    for (const channel of CHANNELS) {
      const { data: convs, error } = await db.from(channel.conversationsTable)
        .select('id, contact_id, resolved_at, agent_handed_off_at, handoff_escalated_at, last_message_preview, contacts!contact_id(first_name, name)')
        .eq('location_id', location.id)
        .not('agent_handed_off_at', 'is', null)
        .is('handoff_escalated_at', null)
        .lt('agent_handed_off_at', cutoffIso)
        .limit(50)
      if (error) {
        console.error(`[radar-agent] handoff-sla candidate query failed (${channel.name}):`, error.message)
        continue
      }

      for (const c of convs || []) {
        try {
          const handedOffAtMs = new Date(c.agent_handed_off_at).getTime()
          const decision = classifyHandoffBreach({
            handedOffAtMs,
            escalatedAt: c.handoff_escalated_at,
            resolvedAtMs: c.resolved_at ? new Date(c.resolved_at).getTime() : null,
            humanRepliedAtMs: await humanRepliedAtMs(db, channel, c.id, handedOffAtMs),
            nowMs,
            slaMinutes,
          })
          if (!decision.breach) { results.skipped++; continue }

          // Stamp FIRST — a push hiccup must not requeue the escalation
          // every 15 minutes forever.
          await db.from(channel.conversationsTable)
            .update({ handoff_escalated_at: new Date(nowMs).toISOString() })
            .eq('id', c.id)

          const contact = c.contacts || {}
          const who = contact.first_name || String(contact.name || '').split(/\s+/)[0] || 'A customer'
          try {
            await sendPushToRolesAtLocation(location.id, MANAGER_ROLES, {
              title: `${channel.label} · still waiting after handoff`,
              body: `${who} has been waiting ${waitingLabel(handedOffAtMs, nowMs)} since Mia handed off — nobody has replied yet.`,
              category: channel.pushCategory,
              data: { type: channel.handoffType, conversation_id: c.id },
            })
          } catch (e) {
            console.error(`[radar-agent] handoff-sla push failed (${channel.name}):`, e?.message || e)
          }
          console.warn('[radar-agent] handoff-sla escalated', JSON.stringify({
            channel: channel.name, conversationId: c.id, waitedMinutes: Math.floor((nowMs - handedOffAtMs) / MIN_MS),
          }))
          results.escalated++
        } catch (e) {
          results.skipped++
          console.error(`[radar-agent] handoff-sla error (${channel.name}):`, e?.message || e)
        }
      }
    }
  }
  return results
}
