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

export function mobileRouteForFeedRow(rowId) {
  return ROUTES[rowId] || null
}
