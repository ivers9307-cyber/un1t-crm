// WA-FLOW-HEALTH — the `flows` webhook field. Meta health-checks a published
// Flow's data-exchange endpoint continuously; an unhealthy endpoint walks the
// Flow PUBLISHED → THROTTLED (sends capped ~10/hr) → BLOCKED (unsendable).
// The "Book your first visit" Flow is the paid-ads capture surface, so a
// THROTTLED transition is a funnel outage and must page managers immediately.
// Mirrors the number-events pattern: pure notification policy + IO wrapper.

export const FLOW_EVENT_FIELDS = new Set(['flows'])

const BAD_STATUSES = new Set(['THROTTLED', 'BLOCKED'])

// Webhook value → { title, body } to push, or null for chatter we ignore.
export function flowNotification(value = {}) {
  const flowName = value.flow_name || value.flow_id || 'a WhatsApp Flow'
  const from = value.old_status
  const to = value.new_status

  if (BAD_STATUSES.has(to)) {
    const detail = to === 'THROTTLED'
      ? 'sends are capped (~10/hr) because Meta sees the Flow endpoint as unhealthy'
      : 'the Flow can no longer be sent or opened'
    return {
      title: `WhatsApp Flow ${to}`,
      body: `🚨 Flow "${flowName}" moved ${from ? `${from} → ` : ''}${to} — ${detail}. If this is the booking Flow, the paid-ads funnel is degraded: check /api/whatsapp/flow health and recent deploys now.`,
    }
  }
  if (to === 'PUBLISHED' && BAD_STATUSES.has(from)) {
    return { title: 'WhatsApp Flow recovered', body: `✅ Flow "${flowName}" is back to PUBLISHED (was ${from}).` }
  }
  if (to === 'DEPRECATED' || to === 'DELETED') {
    return { title: `WhatsApp Flow ${to.toLowerCase()}`, body: `⚠️ Flow "${flowName}" was ${to.toLowerCase()} — template buttons pointing at it will stop working.` }
  }
  return null
}

/**
 * Resolve which locations to notify for a Flow event: the location whose
 * settings.whatsapp_flow.flow_id matches, else every WhatsApp-number location
 * (better to over-page than silently drop a funnel outage).
 */
export async function applyFlowEvent(db, value = {}) {
  const notify = flowNotification(value)
  if (!notify) return { locations: [], notify: null }

  const flowId = String(value.flow_id || '')
  let locations = []
  if (flowId) {
    const { data: locs } = await db.from('locations').select('id, settings')
    locations = (locs || [])
      .filter((l) => String(l.settings?.whatsapp_flow?.flow_id || '') === flowId)
      .map((l) => l.id)
  }
  if (!locations.length) {
    const { data: nums } = await db.from('whatsapp_numbers').select('location_id')
    locations = [...new Set((nums || []).map((n) => n.location_id).filter(Boolean))]
  }
  return { locations, notify }
}
