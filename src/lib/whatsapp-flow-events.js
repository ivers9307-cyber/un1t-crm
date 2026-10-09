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
 * Resolve which locations to notify for a Flow event: the location(s) whose
 * settings.whatsapp_flow.flow_id matches.
 *
 * W0.13 — an unmatched flow_id used to fall back to every location that owns
 * a WhatsApp number ("better to over-page than drop a funnel outage"). In a
 * multi-tenant estate that is a cross-tenant alert: one tenant's Meta notice
 * paged every tenant's managers. Unmatched now notifies NO location, is logged
 * at error level for platform ops (Sentinel reads logs), and returns
 * `unmatched: true`. `notify` is still built so an ops channel can use it.
 *
 * @returns {Promise<{ locations: string[], notify: {title,body}|null, unmatched?: boolean }>}
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
    // W0.13 — never fan an unidentified event out to every tenant's managers.
    console.error(`[wa-flow-events] unmatched flow_id ${flowId || '(none)'}: ${notify.title}`)
    return { locations: [], notify, unmatched: true }
  }
  return { locations, notify, unmatched: false }
}
