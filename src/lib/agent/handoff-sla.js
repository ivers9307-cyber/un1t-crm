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

import { sendPushToRolesAtLocation } from '@/lib/push'
import { MANAGER_ROLES } from '@/lib/schemas'

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
    if (!settings?.enabled && !settings?.test_mode) continue
    const slaMinutes = resolveHandoffSlaMinutes(settings)
    if (!slaMinutes) continue
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
