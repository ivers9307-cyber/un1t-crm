// WA-HEALTH — number/account health webhooks, mirroring whatsapp-template-events:
// pure helpers (column patch + notification policy) + an applyNumberEvent IO
// wrapper the webhook route calls best-effort. Fields covered:
//   phone_number_quality_update  (FLAGGED/UNFLAGGED + limit UPGRADE/DOWNGRADE)
//   phone_number_name_update     (display-name decision)
//   account_update               (bans/restrictions/violations, verification)
//   business_capability_update   (account-level capability changes)
// These push in real time what the number-health poll cron only catches later —
// the number has sat at RED before, so minutes matter.

export const NUMBER_EVENT_FIELDS = new Set([
  'phone_number_quality_update',
  'phone_number_name_update',
  'account_update',
  'business_capability_update',
])

// Webhook field+value → whatsapp_numbers column patch, or null when the event
// carries nothing we persist (account/capability events are notify-only).
export function numberColumnUpdate(field, value = {}) {
  switch (field) {
    case 'phone_number_quality_update': {
      const patch = {}
      if (value.event === 'FLAGGED') patch.quality_rating = 'RED'
      if (value.event === 'UNFLAGGED') patch.quality_rating = 'GREEN'
      if (value.current_limit) patch.messaging_limit_tier = value.current_limit
      return Object.keys(patch).length ? patch : null
    }
    case 'phone_number_name_update':
      return value.decision ? { name_status: value.decision } : null
    default:
      return null
  }
}

// WA-QUALITY.1 — should this event auto-pause in-flight drip broadcasts?
// Returns the operator-facing reason, or null. Only genuine collapses pause:
// quality FLAGGED (→ RED) or a messaging-limit DOWNGRADE. Recoveries
// (UNFLAGGED/UPGRADE) and every other field leave broadcasts alone.
export function broadcastPauseReason(field, value = {}) {
  if (field !== 'phone_number_quality_update') return null
  if (value.event === 'FLAGGED') return 'the number quality was flagged RED by Meta'
  if (value.event === 'DOWNGRADE') {
    return `the messaging limit was downgraded${value.current_limit ? ` to ${value.current_limit}` : ''}`
  }
  return null
}

function restrictionSummary(info) {
  if (!Array.isArray(info) || !info.length) return null
  return info
    .map((r) => `${r.restriction_type || 'restriction'}${r.expiration ? ` until ${r.expiration}` : ''}`)
    .join('; ')
}

// Notification policy → { title, body } to push managers, or null to stay silent.
export function numberNotification(field, value = {}, label) {
  const num = label || value.display_phone_number || 'a WhatsApp number'
  switch (field) {
    case 'phone_number_quality_update': {
      if (value.event === 'FLAGGED') {
        return {
          title: 'WhatsApp number quality FLAGGED',
          body: `🚨 ${num} was flagged by Meta — quality dropped. Pause broadcasts and review recent templates before reach is throttled.`,
        }
      }
      if (value.event === 'UNFLAGGED') {
        return { title: 'WhatsApp number quality recovered', body: `✅ ${num} is no longer flagged by Meta.` }
      }
      if (value.event === 'DOWNGRADE') {
        return {
          title: 'WhatsApp messaging limit DOWNGRADED',
          body: `⚠️ ${num} messaging limit dropped${value.current_limit ? ` to ${value.current_limit}` : ''} — broadcasts may fail beyond the cap.`,
        }
      }
      if (value.event === 'UPGRADE') {
        return { title: 'WhatsApp messaging limit upgraded', body: `✅ ${num} messaging limit is now ${value.current_limit || 'a higher tier'}.` }
      }
      return null
    }
    case 'phone_number_name_update': {
      if (value.decision === 'APPROVED') {
        // Known trap: after a display-name approval, sends can silently fail
        // until the number is re-registered — surface the check in the alert.
        return {
          title: 'WhatsApp display name approved',
          body: `✅ Display name${value.requested_verified_name ? ` "${value.requested_verified_name}"` : ''} approved for ${num}. Verify a test send — approval can require re-registering the number before sends work again.`,
        }
      }
      if (value.decision === 'REJECTED') {
        return {
          title: 'WhatsApp display name rejected',
          body: `❌ Display name change for ${num} was rejected${value.rejection_reason ? `: ${value.rejection_reason}` : ''}.`,
        }
      }
      return null
    }
    case 'account_update': {
      const ev = value.event
      const SEVERE = {
        DISABLED_UPDATE: 'account disabled or updated by Meta',
        ACCOUNT_RESTRICTION: 'account restricted',
        ACCOUNT_VIOLATION: 'policy violation recorded',
        ACCOUNT_DELETED: 'account deleted',
        BANNED: 'account banned',
      }
      if (SEVERE[ev]) {
        const extra = restrictionSummary(value.restriction_info)
        return {
          title: 'WhatsApp Business account alert',
          body: `🚨 ${SEVERE[ev]} (${ev})${extra ? ` — ${extra}` : ''}. Check WhatsApp Manager immediately; sends may be failing.`,
        }
      }
      if (ev === 'VERIFIED_ACCOUNT') {
        return { title: 'WhatsApp business verified', body: '✅ Meta business verification completed for the WhatsApp account.' }
      }
      return null
    }
    case 'business_capability_update': {
      const parts = []
      if (value.max_daily_conversation_per_phone != null) parts.push(`daily template conversations per number: ${value.max_daily_conversation_per_phone}`)
      if (value.max_phone_numbers_per_business != null) parts.push(`max phone numbers: ${value.max_phone_numbers_per_business}`)
      if (!parts.length) return null
      return { title: 'WhatsApp capability update', body: `ℹ️ Meta updated account capabilities — ${parts.join('; ')}.` }
    }
    default:
      return null
  }
}

/**
 * Apply a number/account health webhook: match the whatsapp_numbers row by the
 * event's display phone number (digits-only compare — Meta formats with spaces),
 * patch changed columns idempotently, and return which locations to notify.
 * Account-level events (no phone number) fan out to every number's location.
 * Best-effort caller; may throw — the route wrapper swallows.
 *
 * WA-QUALITY.1 — a quality collapse (FLAGGED / limit DOWNGRADE) also auto-pauses
 * the matched location's in-flight drip broadcasts (status='sending',
 * delivery_mode='drip', not already paused): the FLAGGED push used to say
 * "Pause broadcasts" while nothing did it, and a drip left running drains the
 * list into a throttled number. Idempotent twice over: an already-applied
 * column patch skips the pause entirely (Meta redelivery), and the
 * `paused_at IS NULL` filter makes a re-run a DB no-op. Blasts run inline on
 * the request thread so there is nothing in-flight to pause; new blasts are
 * refused by the preflight quality gate in sendBroadcast (WA-QUALITY.2).
 *
 * @returns {Promise<{ locations: string[], notify: {title,body}|null, matched?: object, pausedBroadcasts: Array<{id: string, name: string}> }>}
 */
export async function applyNumberEvent(db, field, value = {}) {
  const { data: rows } = await db.from('whatsapp_numbers')
    .select('id, location_id, label, display_phone, quality_rating, messaging_limit_tier, name_status')
  const numbers = rows || []

  const digits = String(value.display_phone_number || value.phone_number || '').replace(/\D/g, '')
  const matched = digits
    ? numbers.find((r) => String(r.display_phone || '').replace(/\D/g, '') === digits) || null
    : null

  const update = numberColumnUpdate(field, value)
  let unchanged = false
  if (matched && update) {
    unchanged = Object.entries(update).every(([k, v]) => matched[k] === v)
    if (!unchanged) await db.from('whatsapp_numbers').update(update).eq('id', matched.id)
  }

  // Quality collapse → pause the matched location's in-flight drips. Gated on
  // `matched` (an unmatched event can't scope the pause to a location) and on
  // the patch actually changing something (redelivered events stay no-ops).
  const pauseReason = matched && !unchanged ? broadcastPauseReason(field, value) : null
  let pausedBroadcasts = []
  if (pauseReason) {
    const { data: pausedRows } = await db.from('whatsapp_broadcasts')
      .update({ paused_at: new Date().toISOString() })
      .eq('location_id', matched.location_id)
      .eq('status', 'sending')
      .eq('delivery_mode', 'drip')
      .is('paused_at', null)
      .select('id, name')
    pausedBroadcasts = pausedRows || []
  }

  // Idempotency: a Meta retry of a column-bearing event we already applied
  // stays silent. Notify-only events (account/capability) always notify.
  let notify = unchanged ? null : numberNotification(field, value, matched?.label)
  if (notify && pausedBroadcasts.length) {
    const plural = pausedBroadcasts.length === 1 ? '' : 's'
    notify = {
      ...notify,
      body: `${notify.body} Auto-paused ${pausedBroadcasts.length} in-flight drip broadcast${plural} because ${pauseReason} — resume from the broadcast page once the number recovers.`,
    }
  }

  const locations = matched
    ? [matched.location_id]
    : [...new Set(numbers.map((r) => r.location_id).filter(Boolean))]

  return { locations, notify, matched, pausedBroadcasts }
}
