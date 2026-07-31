// Android notification channels for the STAFF app (mobile/) — single
// source of truth for the channel specs AND the category→channel map.
//
// Imported from BOTH sides of the seam:
//   - mobile/lib/push-register.js creates every channel at registration
//     (Android needs channels to exist before a channelId send lands in
//     the right bucket).
//   - src/lib/push.js stamps `channelId` on every Expo message it builds,
//     derived from payload.category (+ payload.data.type for the few
//     categories whose fine-grained types belong in different channels).
//
// ⚠️ Android channels are IMMUTABLE once created on a device: the user
// owns the settings from that point, and importance can never be raised
// programmatically — only lowered by the user. Renaming/re-speccing a
// channel requires a NEW channel id (and the old one lingers in the
// system settings UI until deleted). So: pick specs carefully, and treat
// the ids below as append-only.
//
// Importance is stored as a lowercase string key (this module is shared
// with the server, which must not import expo-notifications). The mobile
// registrar maps it via Notifications.AndroidImportance[key.toUpperCase()]:
//   max     → heads-up banner + sound (use sparingly — real-time human chat)
//   high    → heads-up banner + sound (time-sensitive, actionable)
//   default → sound, no heads-up (informational)
//
// iOS ignores channelId entirely — sends are unchanged there.

export const ANDROID_CHANNELS = Object.freeze({
  messages: Object.freeze({
    name: 'Messages',
    description: 'Inbound WhatsApp and Instagram messages, and agent handoffs that need a human.',
    importance: 'max',
  }),
  reminders: Object.freeze({
    name: 'Reminders',
    description: 'Task, booking and checklist reminders, and new leads to action.',
    importance: 'high',
  }),
  approvals: Object.freeze({
    name: 'Approvals',
    description: 'Swaps, time-off requests and expense claims awaiting your decision.',
    importance: 'high',
  }),
  updates: Object.freeze({
    name: 'Updates',
    description: 'Decisions on your requests, schedule changes, invoices, contracts and issue reports.',
    importance: 'default',
  }),
  alerts: Object.freeze({
    name: 'Platform alerts',
    description: 'WhatsApp number/template health and checklist compliance alerts.',
    importance: 'default',
  }),
  // Legacy channel — every install created it pre-channels, and it's the
  // fallback for unknown/unmapped categories (e.g. the /admin test push,
  // category 'test'). Keep the original lowercase name: re-registering an
  // existing id with a different spec is a no-op on devices that have it.
  default: Object.freeze({
    name: 'default',
    description: 'Everything else.',
    importance: 'default',
  }),
})

// payload.category → channel id. Categories mirror NOTIFICATION_REGISTRY
// (src/lib/notifications-registry.js) plus 'instagram' (rides its own
// notify_instagram gate but isn't in the registry).
const CATEGORY_CHANNELS = Object.freeze({
  // Real-time human conversation — heads-up.
  whatsapp: 'messages',
  instagram: 'messages',
  // Time-sensitive nudges (cron lead-time reminders + speed-to-lead).
  tasks: 'reminders',
  bookings: 'reminders',
  checklist_overdue: 'reminders',
  lead: 'reminders',
  // Needs a manager decision.
  swap: 'approvals',
  time_off: 'approvals',
  expense_submitted: 'approvals',
  agent_requests: 'approvals', // customer approval queued by Mia / the /start funnel
  host_event_review: 'approvals', // host submitted an event for review
  // Informational outcomes / FYIs.
  agent_activity: 'updates', // "Mia is handling a chat" — an ambient FYI, not a heads-up
  schedule: 'updates',
  shift_adjusted: 'updates',
  invoice_approved: 'updates',
  invoice_declined: 'updates',
  expense_approved: 'updates',
  expense_declined: 'updates',
  contract_issued: 'updates',
  issue_submitted: 'updates',
  issue_resolved: 'updates',
  // Ops-health surveillance.
  checklist_compliance: 'alerts',
})

// data.type overrides — where one category spans channels. Types mirror
// mobile/lib/notification-nav.js (the payload owner's canonical type list).
const TYPE_CHANNELS = Object.freeze({
  // 'swap' outcomes are FYIs, not decisions (the inbound/awaiting types
  // stay on the category default 'approvals').
  swap_claimed: 'updates',
  swap_accepted: 'updates',
  swap_withdrawn: 'updates',
  swap_declined: 'updates',
  swap_decision: 'updates',
  // 'time_off' decision back to the requester is an FYI.
  time_off_decision: 'updates',
  // STAFF-DEV.8 — the "your app is out of date" nudge. It rides NO
  // category (an unregistered notify_ key resolves to false and would
  // suppress the send), so the type is the only routing signal it has.
  app_update: 'updates',
  // WA health/template webhooks ride category 'whatsapp' (for the
  // notify_whatsapp opt-in) but are ops alerts, not chat.
  wa_quality: 'alerts',
  number_health: 'alerts',
  flow_health: 'alerts',
  template_status: 'alerts',
})

/**
 * Resolve the Android channel id for a staff push payload.
 * Unknown categories/types fall back to the legacy 'default' channel
 * (Android would otherwise auto-create a system "Miscellaneous" channel
 * for an unknown channelId — we never want that).
 *
 * @param {object} [payload]
 * @param {string} [payload.category]  sendPush payload.category
 * @param {string} [payload.type]      sendPush payload.data.type
 * @returns {string} a key of ANDROID_CHANNELS
 */
export function androidChannelId({ category, type } = {}) {
  if (type && TYPE_CHANNELS[type]) return TYPE_CHANNELS[type]
  if (category && CATEGORY_CHANNELS[category]) return CATEGORY_CHANNELS[category]
  return 'default'
}
