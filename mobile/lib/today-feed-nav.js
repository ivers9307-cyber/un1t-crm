// MOBILE-TODAY-FEED — feed-row id → mobile route. The row ids are
// owned by shared/today-feed.js assembleTodayFeed(); this maps each to
// an existing mobile screen, or null when there's no sensible mobile
// destination (the row renders as informational, non-tappable).
//
// Deliberate nulls:
//   invoices — the mobile invoices surface is contractor self-service;
//              the feed row counts the operator email-in inbox
//              (web /invoices), a different capability. Wrong target.
//   lowfill  — class booking lives in the web unified inbox only.

const ROUTES = Object.freeze({
  approvals: '/approvals',
  issues: '/issues',
  whatsapp: '/whatsapp',
  bookings: '/bookings',
  churn: '/radar',
  tasks: '/tasks',
})

// C146 TASKSNEEDCONTACTS.1 — the server's tasks row is gated on the web
// `activities` key, which knows nothing of Contacts; at a studio where the
// phone hides Tasks (canUseTasksHere) the row stays informational instead of
// opening a screen that would only say Tasks is off. Callers that omit the
// option keep the plain mapping.
export function mobileRouteForFeedRow(rowId, { canUseTasks = true } = {}) {
  if (rowId === 'tasks' && !canUseTasks) return null
  return ROUTES[rowId] || null
}
