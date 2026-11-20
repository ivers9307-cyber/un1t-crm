// EQUIP-MAINT.3 — Vercel cron, daily 06:00 UTC.
// TZ.6 — the schedule is hourly; each location acts at its daily slot:
// 06:00 UTC for a Europe/Dublin studio (as before), 06:00 local for any
// other zone, at most once per local day (src/lib/cron-daily-slot.js). "Today"
// is the location's own day.
//
// For each enabled location whose inspection weekday is today (its own day),
// count what is due and push it to everyone holding equipment_inspect.
// Silent when the count is zero — a "nothing due" push trains people to
// ignore the channel.
//
// Per-location error isolation: one bad location never stops the loop.
// Push delivery is best-effort; sendPush returns counts and never throws.
// A failed recipients read (recipients_failed) is not recorded or audited
// as a sent reminder (C1 RECIPIENTS.1).
//
// defineCron owns the CRON_SECRET check, the error boundary and the heartbeat.
// A quiet tick (no studio at its slot) answers success with `stamp: false`, so
// the row keeps its daily clock; a slot tick stamps unless the gate faulted (a
// claim write failed), which answers 500 unstamped. One studio failing is
// reported in its result (fixed text; the detail is logged), never a failed run.

import { defineCron } from '@/lib/define-cron'
import { listEnabledSettings, listActiveEquipment, listSubmittedSince } from '@/lib/equipment-db'
import { isInspectionDay, selectOutstanding, buildReminderBody } from '@/lib/equipment-cron'
import { sendPushToRolesAtLocation } from '@/lib/push'
import { gateDailySlot, slotFor } from '@/lib/cron-daily-slot'
import { logAuditEvent } from '@/lib/audit'
import { logWarn } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const ROLES = ['owner', 'master', 'manager', 'head_coach', 'staff', 'reception']

export const GET = defineCron({ heartbeat: 'equipment-inspection-reminder' }, async ({ db }) => {
  const results = []

  // TZ.6 — which locations are at their daily slot this tick (claimed, so
  // never twice in one local day). An unreadable zone acts for nobody.
  const gate = await gateDailySlot(db, 'equipment-inspection-reminder', { module: 'equipment-cron' })
  if (!gate.ok) return { ok: false, body: { error: 'locations unreadable', slot: gate.summary } }
  if (gate.slots.size === 0) {
    // TZ.6: a quiet tick (no slot taken) never stamps, so the row keeps the legacy
    // clock; a faulted one (a claim write failed) answers 500 and the slot pages.
    return { ok: !gate.faulted, stamp: false, body: { data: { locations: results, slot: gate.summary } } }
  }

  let settingsRows = []
  try {
    settingsRows = await listEnabledSettings(db)
  } catch (err) {
    logWarn('equipment-cron', 'listEnabledSettings failed', { error: err.message })
    return { ok: false, body: { error: 'Could not read the equipment settings' } }
  }

  for (const settings of settingsRows) {
    const slot = slotFor(gate.slots, settings.location_id)
    if (!slot) continue // TZ.6: not this location's slot
    const today = slot.day
    if (!isInspectionDay(settings, today)) continue
    try {
      const [assets, submitted] = await Promise.all([
        listActiveEquipment(db, settings.location_id),
        listSubmittedSince(db, settings.location_id, today),
      ])
      const outstanding = selectOutstanding({ assets, submitted, today })
      if (outstanding.length === 0) {
        results.push({ locationId: settings.location_id, due: 0, pushed: false })
        continue
      }

      const r = await sendPushToRolesAtLocation(settings.location_id, ROLES, {
        title: 'Equipment inspections due',
        body: buildReminderBody(outstanding),
        data: { type: 'equipment_inspection' },
        // BARE — push.js prepends `notify_` itself, so this gates on
        // notify_inspection_due (registered in MOBILE_PERMISSIONS). The
        // prefixed form resolved notify_notify_…, which is unregistered
        // and reaches no one but master (PUSHCAT.1).
        category: 'inspection_due',
      })

      // C1 RECIPIENTS.1 — the recipients read failed (push.js logged it):
      // nobody was told, so this is not a sent reminder and is not audited
      // as one. The 19:00 UTC overdue sweep does chase the same assets
      // today, but it notifies ONLY owner + master; this reminder goes to all
      // six ROLES, including the staff who do the inspections. Those staff
      // (and manager, head_coach, reception) are NOT re-chased the same day.
      if (r?.recipients_failed) {
        results.push({ locationId: settings.location_id, due: outstanding.length, pushed: false, recipients_failed: true })
        continue
      }
      // C16 PUSHREADERR.1 — push.js could not read who may be told or their
      // devices, and nobody was told: not a sent reminder, not audited as one.
      // Someone told (a partial send under an unreadable template) still counts.
      if (r?.read_failed && !((r.sent || 0) > 0)) {
        results.push({ locationId: settings.location_id, due: outstanding.length, pushed: false, read_failed: true })
        continue
      }

      await logAuditEvent({
        category: 'business',
        action: 'equipment.inspection_reminder_sent',
        actor: null,
        target: { resource: `location/${settings.location_id}` },
        locationId: settings.location_id,
        details: { due_count: outstanding.length, today },
      })
      results.push({ locationId: settings.location_id, due: outstanding.length, pushed: true })
    } catch (err) {
      logWarn('equipment-cron', 'reminder failed for location', {
        locationId: settings.location_id, error: err.message,
      })
      results.push({ locationId: settings.location_id, error: 'reminder failed' })
    }
  }

  // A slot tick stamps (slotTickStampable: the gate read and some slot was
  // taken); a faulted one answers 500 unstamped.
  return { ok: !gate.faulted, body: { data: { locations: results, slot: gate.summary } } }
})
