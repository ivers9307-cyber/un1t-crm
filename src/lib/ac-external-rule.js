// STUDIO-AC-EXTERNAL-RULE.1 — pure-ish helpers around the
// ac_external_starts table. Keeps the cron route slim and the
// state-transition logic testable in isolation.
//
// The model:
//   - Each device may have external_auto_off_minutes set (NULL =
//     no rule for this unit; cron ignores it entirely).
//   - When the cron observes a device as on, with no active CRM
//     session and no existing ac_external_starts row, it inserts
//     one — first_seen_at = now, expected_off_at = now + cap.
//   - When the cron observes a device that has an external row
//     but is now off OR has acquired a real session OR has passed
//     its expected_off_at AND the cron has fired the auto-off,
//     we delete the row.
//
// Decision: the timer is anchored to "first seen by cron", not
// "started externally" — we have no reliable way to know when the
// user actually hit the wall panel. In the worst case (cron just
// missed the unit starting) the rule fires up to one cron tick
// late, which is fine. In the best case (cron observes the start
// immediately) the rule fires exactly on time.
//
// Decision: we do NOT reset the timer on subsequent cron ticks
// that still observe vendor_on. The first observation wins. This
// is what makes the rule a hard ceiling rather than a sliding
// window.

import { logWarn } from '@/lib/log'

/**
 * Decide what to do with a device based on (a) whether the vendor
 * says it's on, (b) whether there's an active CRM session, (c) any
 * existing ac_external_starts row.
 *
 * Pure function — no DB writes. Returns a directive:
 *   - { action: 'noop' }                 // do nothing
 *   - { action: 'insert', expected_off_at, first_seen_at }
 *   - { action: 'clear', reason }        // delete the row
 *   - { action: 'fire', startedAt }      // auto-off now, then clear
 *
 * Callers feed in the live observation; this function picks the
 * transition.
 */
export function planExternalRule({
  vendorOn,
  hasActiveSession,
  externalRow,           // null or { device_id, first_seen_at, expected_off_at }
  externalAutoOffMinutes,
  now = new Date(),
}) {
  // Rule disabled for this device → never touch the table for it.
  // The cron should also skip vendor-poll, but a stale row from
  // before the master NULLed the column would still be cleared
  // here on the off chance we got called.
  if (externalAutoOffMinutes == null || externalAutoOffMinutes <= 0) {
    if (externalRow) return { action: 'clear', reason: 'rule_disabled' }
    return { action: 'noop' }
  }

  // Unit is off → no need for a row.
  if (!vendorOn) {
    if (externalRow) return { action: 'clear', reason: 'vendor_off' }
    return { action: 'noop' }
  }

  // Real session exists → the existing auto-off cron handles it.
  // Drop any stale external row so the two crons don't both try
  // to turn the same unit off.
  if (hasActiveSession) {
    if (externalRow) return { action: 'clear', reason: 'session_took_over' }
    return { action: 'noop' }
  }

  // Vendor says on, no session. Either insert or fire.
  if (!externalRow) {
    const firstSeenAt = now
    const expectedOffAt = new Date(now.getTime() + externalAutoOffMinutes * 60_000)
    return {
      action: 'insert',
      first_seen_at: firstSeenAt.toISOString(),
      expected_off_at: expectedOffAt.toISOString(),
    }
  }

  // Existing row. Has it expired?
  const expected = new Date(externalRow.expected_off_at).getTime()
  if (Number.isFinite(expected) && expected <= now.getTime()) {
    return { action: 'fire', startedAt: externalRow.first_seen_at }
  }

  // Still within window. Don't reset.
  return { action: 'noop' }
}

/**
 * Insert (or upsert-replace) the external-start row for a device.
 * Returns { ok, error? }.
 */
export async function upsertExternalStart(db, { deviceId, firstSeenAt, expectedOffAt }) {
  const { error } = await db
    .from('ac_external_starts')
    .upsert({
      device_id: deviceId,
      first_seen_at: firstSeenAt,
      expected_off_at: expectedOffAt,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'device_id' })
  if (error) {
    logWarn('ac-external-rule', 'upsert failed', { deviceId, error: error.message })
    return { ok: false, error: error.message }
  }
  return { ok: true }
}

/**
 * Delete the external-start row for a device. Idempotent — missing
 * row is not an error.
 */
export async function clearExternalStart(db, deviceId) {
  const { error } = await db
    .from('ac_external_starts')
    .delete()
    .eq('device_id', deviceId)
  if (error) {
    logWarn('ac-external-rule', 'clear failed', { deviceId, error: error.message })
    return { ok: false, error: error.message }
  }
  return { ok: true }
}

/**
 * Read the external-start row for a single device, or null.
 */
export async function getExternalStart(db, deviceId) {
  const { data } = await db
    .from('ac_external_starts')
    .select('device_id, first_seen_at, expected_off_at')
    .eq('device_id', deviceId)
    .maybeSingle()
  return data || null
}
