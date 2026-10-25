// SCREENMODE.10 — the screen pass of the fleet-health cron.
//
// Android TV boxes (fleet_devices.role = 'screen') are not on the tailnet, so
// the Tailscale pass never sees them. Their pulse is last_heartbeat_at, stamped
// when a box fetches its plan (GET /api/fleet/screen-plan). This pass grades
// them on that alone and runs BEFORE any Tailscale call, so an unconfigured or
// unreachable Tailscale cannot blind it.
//
// Only CLAIMED screens (location_id set) are graded: an unclaimed box has no
// studio to be dark in.
//
// Never throws. The cron's Pi pass must run whatever happens here, and a screen
// failure that took the Pis down with it would be the wrong way round.

import { gradeScreen, decideAlert, rollbackUndeliveredAlerts } from '@/lib/fleet-health'
import { logInfo, logWarn, logError } from '@/lib/log'

/**
 * @param {object} db supabase service client
 * @param {{ nowMs: number, notify: (db: object, alerts: object[]) => Promise<boolean> }} opts
 *   `notify` is the cron's own function, so a screen alert renders exactly like a Pi's.
 * @returns {Promise<{ checked: number, alerted: number }>}
 */
export async function runScreenHealth(db, { nowMs, notify }) {
  try {
    const { data: screens, error: screenError } = await db
      .from('fleet_devices')
      .select('device_name, last_heartbeat_at, location_id')
      .eq('role', 'screen')
      .not('location_id', 'is', null)
    if (screenError) throw new Error(`fleet_devices: ${screenError.message}`)
    if (!screens?.length) return { checked: 0, alerted: 0 }

    const names = screens.map((s) => s.device_name)
    // A failed prior read must skip the pass, not grade against "no history":
    // every outage would look new and re-alert on every tick of a DB blip.
    const { data: priorRows, error: priorError } = await db
      .from('fleet_device_health')
      .select('device_name, state, state_since, alerted_at, suppressed_until')
      .in('device_name', names)
    if (priorError) throw new Error(`fleet_device_health: ${priorError.message}`)
    const priorByName = new Map((priorRows || []).map((r) => [r.device_name, r]))

    const alerts = []
    const rows = []
    for (const screen of screens) {
      const graded = gradeScreen(screen, nowMs)
      const { alert, row } = decideAlert(graded, priorByName.get(graded.name) ?? null, nowMs)
      rows.push(row)
      if (alert) alerts.push({ ...graded, alert, row })
    }

    if (alerts.length) {
      // Notify BEFORE persisting: alerted_at is a claim that someone was told.
      // See the Pi pass in the cron for the full argument.
      let delivered = false
      try {
        delivered = await notify(db, alerts)
      } catch (err) {
        logError('fleet-health', 'failed to notify (screens)', { err: String(err), count: alerts.length })
      }
      if (delivered) {
        logInfo('fleet-health', 'screen alerts sent', {
          count: alerts.length,
          alerts: alerts.map((a) => `${a.name}:${a.alert}`),
        })
      } else {
        logError('fleet-health', 'screen alert reached nobody — will retry next tick', {
          alerts: alerts.map((a) => `${a.name}:${a.alert}`),
        })
        rollbackUndeliveredAlerts(alerts, priorByName)
      }
    }

    const { error } = await db.from('fleet_device_health').upsert(rows, { onConflict: 'device_name' })
    if (error) logWarn('fleet-health', 'failed to persist screen state', { err: error })

    return { checked: rows.length, alerted: alerts.length }
  } catch (err) {
    logError('fleet-health', 'screen pass skipped', { err: String(err) })
    return { checked: 0, alerted: 0 }
  }
}
