// CHECKLIST.3 — deadline-sweep helpers for the cron in
// /api/cron/checklist-sweep.
//
// Pure pieces live here so the route stays slim and the
// decision logic is easy to unit test.
//
// Notification model
// - Compliance push (category 'checklist_compliance') goes to
//   head coach + owner + master at the instance's location. The
//   push.js helper sendPushToRolesAtLocation filters by the
//   notify_<category> opt-out automatically.
// - Personal push (category 'checklist_overdue') goes to the
//   coach themselves so they know their shift ended with items
//   missed. notify_checklist_overdue defaults on for all roles.
//
// We never re-notify on the same incomplete instance — the cron
// only transitions pending → incomplete once, so the push fan-out
// runs exactly once per (profile, date, template).

import { logWarn } from '@/lib/log'

// Roles that get the compliance roll-up by default. push.js
// honours per-user notify_checklist_compliance toggles on top
// of this list.
export const COMPLIANCE_ROLES = Object.freeze(['head_coach', 'owner', 'master'])

/**
 * Compute the list of unticked items from an instance's snapshot
 * + items_checked map. Pure. Used by the cron to build the
 * notification body and by the compliance dashboard surface.
 *
 * Returns:
 *   [{ id, label, order }]   — array, preserves snapshot order.
 */
export function listMissedItems(instance) {
  if (!instance) return []
  const items = Array.isArray(instance.items) ? instance.items : []
  const checked = new Set(Object.keys(instance.items_checked || {}))
  return items
    .filter((i) => !checked.has(i.id))
    .sort((a, b) => (a.order || 0) - (b.order || 0))
}

/**
 * Build a concise notification body listing missed items.
 * Caps at 3 names + "and N more" to keep the push body under
 * APNs's display limit.
 *
 *   buildOverdueBody([{label:'Wipe kettlebells'}, …])
 *   → "Wipe kettlebells, Sanitise pads, Lock back door + 2 more"
 *
 * Returns null when nothing's missed (caller should skip the push).
 */
export function buildOverdueBody(missedItems, { maxNames = 3 } = {}) {
  if (!Array.isArray(missedItems) || missedItems.length === 0) return null
  const names = missedItems.map((i) => i.label).filter(Boolean)
  if (names.length === 0) return null
  if (names.length <= maxNames) {
    return names.join(', ')
  }
  const shown = names.slice(0, maxNames).join(', ')
  return `${shown} + ${names.length - maxNames} more`
}

/**
 * Decide whether a row should be swept this tick. Pure. Mainly a
 * defensive double-check inside the route so we never accidentally
 * mark a 'complete' row as 'incomplete' from a stale read.
 *
 *   { eligible: true }                       → fire
 *   { eligible: false, reason: 'not_pending' }
 *   { eligible: false, reason: 'no_deadline' }
 *   { eligible: false, reason: 'not_due_yet' }
 */
export function isEligibleForSweep(instance, now = new Date()) {
  if (!instance) return { eligible: false, reason: 'missing' }
  if (instance.status !== 'pending') {
    return { eligible: false, reason: 'not_pending' }
  }
  if (!instance.deadline_at) {
    return { eligible: false, reason: 'no_deadline' }
  }
  const due = new Date(instance.deadline_at).getTime()
  if (!Number.isFinite(due)) return { eligible: false, reason: 'no_deadline' }
  if (due > now.getTime()) {
    return { eligible: false, reason: 'not_due_yet' }
  }
  return { eligible: true }
}

/**
 * Transition a single instance to 'incomplete' in the DB. The
 * route loops over each due row and calls this, then dispatches
 * pushes. Returns the updated row or null on failure.
 *
 * Note we DON'T touch items_checked — operators may still want to
 * see "they got 4 of 6 done" on the compliance dashboard in PR
 * follow-ups.
 */
export async function markIncomplete(db, instanceId) {
  if (!instanceId) return null
  const { data, error } = await db
    .from('checklist_instances')
    // Concurrency-safe: only flip if the row is still 'pending'.
    // If a coach finished the last item between the SELECT and
    // this UPDATE we don't want to roll them back.
    .update({ status: 'incomplete' })
    .eq('id', instanceId)
    .eq('status', 'pending')
    .select()
    .single()
  if (error) {
    logWarn('checklist-sweep', 'mark incomplete failed', { instanceId, error: error.message })
    return null
  }
  return data
}
