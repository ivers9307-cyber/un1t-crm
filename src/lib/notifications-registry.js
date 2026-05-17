// NOTIF.3 — source-of-truth registry for every push-notification
// category the CRM sends. Powers /settings/notifications (the
// read-only registry view) and is the canonical list of valid
// category strings for the send-push-reminders cron + push.js
// gating logic.
//
// Adding a new notification:
//   1. Add an entry here.
//   2. Add `notify_<category>` to MOBILE_PERMISSIONS in
//      shared/permissions.js (otherwise no per-user gate exists
//      and EVERY user gets the push).
//   3. Have the sender call sendPush({ category: '<key>', ... }).
//
// Removing a notification: delete the entry here AND the
// MOBILE_PERMISSIONS entry — push.js will then silently noop on
// the dead category (the m[`notify_${cat}`] check returns
// undefined which is treated as "allowed", but no caller exists,
// so nothing fires).

/**
 * `trigger.kind` tells the UI how to label when this notification
 * fires:
 *   - 'event'     — fires synchronously from an HTTP route on a
 *                   specific user action (form submission, status
 *                   change, etc.). No timing config.
 *   - 'cron'      — fires from a scheduled job. May have configurable
 *                   lead times.
 *   - 'webhook'   — fires from an inbound webhook (Postmark,
 *                   Twilio, WhatsApp, Calendly).
 *
 * `recipients` tells the UI who gets it:
 *   - 'assignee'              — single user the entity is assigned to
 *   - 'requester'             — user who initiated the underlying request
 *   - 'roles_at_location'     — fan-out to all users with the listed
 *                               roles at the entity's location
 *   - 'specific_user'         — the user named in the entity's data
 *                               (e.g. contract recipient)
 *   - 'individual_or_creator' — varies based on the trigger
 */
export const NOTIFICATION_REGISTRY = Object.freeze([
  {
    category: 'tasks',
    label: 'Task reminders',
    description: 'Lead-time reminders before a task is due. Lead times configurable per location.',
    trigger: { kind: 'cron', source: '/api/cron/send-push-reminders (every 5 min)' },
    recipients: { kind: 'assignee', detail: 'activities.assignee_id' },
    configurable: { leadTimes: true, roles: false },
    defaults: { leadTimesMinutes: [60, 1440] },
  },
  {
    category: 'bookings',
    label: 'Booking reminders',
    description: 'Lead-time reminders before a confirmed booking starts. Lead times and recipient roles configurable per location.',
    trigger: { kind: 'cron', source: '/api/cron/send-push-reminders (every 5 min)' },
    recipients: { kind: 'roles_at_location', detail: 'owner / manager / head_coach by default' },
    configurable: { leadTimes: true, roles: true },
    defaults: {
      leadTimesMinutes: [60, 1440],
      notifyRoles: ['owner', 'manager', 'head_coach'],
    },
  },
  {
    category: 'time_off',
    label: 'Time-off decisions',
    description: 'When your own time-off request is approved or declined, and when a new request lands for managers to review.',
    trigger: { kind: 'event', source: 'PUT /api/schedule/time-off/[id] (status change) + POST /api/schedule/time-off (new request)' },
    recipients: { kind: 'individual_or_creator', detail: 'Requester (on decision) or owner/manager (on new request)' },
    configurable: { leadTimes: false, roles: false },
  },
  {
    category: 'schedule',
    label: 'Schedule published',
    description: "Fires when a new week's schedule is published.",
    trigger: { kind: 'event', source: 'POST /api/schedule/publish' },
    recipients: { kind: 'roles_at_location', detail: 'All staff with shifts in the published week' },
    configurable: { leadTimes: false, roles: false },
  },
  {
    category: 'swap',
    label: 'Swap requests',
    description: 'Inbound swap requests for managers, and swap-request response for the requester.',
    trigger: { kind: 'event', source: 'POST/PUT /api/schedule/swaps' },
    recipients: { kind: 'individual_or_creator', detail: 'Managers (new request) or requester (decision)' },
    configurable: { leadTimes: false, roles: false },
  },
  {
    category: 'lead',
    label: 'New leads assigned',
    description: 'Fires when a new contact is created at your location.',
    trigger: { kind: 'event', source: 'POST /api/contacts + WhatsApp inbound + Calendly webhook' },
    recipients: { kind: 'roles_at_location', detail: 'owner / manager / head_coach' },
    configurable: { leadTimes: false, roles: false },
  },
  {
    category: 'whatsapp',
    label: 'WhatsApp messages',
    description: 'Inbound WhatsApp message. Also requires the WhatsApp Inbox permission.',
    trigger: { kind: 'webhook', source: 'WhatsApp Cloud API → /api/webhooks/whatsapp' },
    recipients: { kind: 'roles_at_location', detail: 'All users with whatsapp permission at the location' },
    configurable: { leadTimes: false, roles: false },
  },
  {
    category: 'invoice_approved',
    label: 'Invoice approved',
    description: 'Contractor invoice has been approved for payment.',
    trigger: { kind: 'event', source: 'PUT /api/contractor-invoices/[id] (status=approved)' },
    recipients: { kind: 'specific_user', detail: 'Invoice submitter (contractor)' },
    configurable: { leadTimes: false, roles: false },
  },
  {
    category: 'invoice_declined',
    label: 'Invoice declined',
    description: 'Contractor invoice needs adjustment before approval.',
    trigger: { kind: 'event', source: 'PUT /api/contractor-invoices/[id] (status=declined)' },
    recipients: { kind: 'specific_user', detail: 'Invoice submitter (contractor)' },
    configurable: { leadTimes: false, roles: false },
  },
  {
    category: 'shift_adjusted',
    label: 'Shift adjusted',
    description: 'A manager changed the times on one of your shifts (partial-shift override).',
    trigger: { kind: 'event', source: 'PUT /api/schedule/shift-assignments/[id]' },
    recipients: { kind: 'assignee', detail: 'Coach whose shift was edited' },
    configurable: { leadTimes: false, roles: false },
  },
  {
    category: 'contract_issued',
    label: 'Contract issued',
    description: 'A digital contract has been issued to you for signature.',
    trigger: { kind: 'event', source: 'POST /api/contracts/issue' },
    recipients: { kind: 'specific_user', detail: 'Contract recipient' },
    configurable: { leadTimes: false, roles: false },
  },
])

/**
 * Get the registry entry for a category, or null if unknown.
 */
export function getNotificationCategory(category) {
  return NOTIFICATION_REGISTRY.find(n => n.category === category) || null
}

/**
 * All notification category strings. Useful for validation +
 * iterating in tests.
 */
export const NOTIFICATION_CATEGORIES = Object.freeze(
  NOTIFICATION_REGISTRY.map(n => n.category)
)

/**
 * Categories that have a per-location config surface (lead times,
 * recipient roles). Drives which categories show up in the
 * NotificationConfigCard editor on the per-location settings page.
 */
export const CONFIGURABLE_CATEGORIES = Object.freeze(
  NOTIFICATION_REGISTRY.filter(n => n.configurable.leadTimes || n.configurable.roles)
)
