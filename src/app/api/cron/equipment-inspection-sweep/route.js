// EQUIP-MAINT.3 — Vercel cron, daily 19:00 UTC.
//
// For EVERY enabled location (not just today's inspection weekday — an
// asset can be overdue on any day), count what is still outstanding and
// chase owner + master. Silent when the count is zero.
//
// Flips NO state: unlike checklist_instances, equipment_inspections has
// no 'incomplete' status and adding one would need a migration. The
// asset simply stays overdue and stays top of the due list.
//
// Per-location error isolation: one bad location never stops the loop.
// Push delivery is best-effort; sendPushOnce returns counts and never
// throws.
//
// Auth: CRON_SECRET Bearer, same as every other cron.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { listEnabledSettings, listActiveEquipment, listSubmittedSince } from '@/lib/equipment-db'
import { selectOutstanding, buildOverdueBody } from '@/lib/equipment-cron'
import { resolveRoleRecipientIds } from '@/lib/push'
import { sendPushOnce } from '@/lib/push-dedup'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { dublinTodayStr } from '@/lib/dublin-time'
import { logAuditEvent } from '@/lib/audit'
import { logWarn } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const ROLES = ['owner', 'master']

export async function GET(request) {
  const auth = request.headers.get('authorization') || ''
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  }

  const db = createServerClient()
  const today = dublinTodayStr()
  const results = []

  let settingsRows = []
  try {
    settingsRows = await listEnabledSettings(db)
  } catch (err) {
    logWarn('equipment-cron', 'listEnabledSettings failed', { error: err.message })
    return NextResponse.json({ success: false, error: err.message }, { status: 500 })
  }

  for (const settings of settingsRows) {
    try {
      const [assets, submitted] = await Promise.all([
        listActiveEquipment(db, settings.location_id),
        listSubmittedSince(db, settings.location_id, today),
      ])
      const outstanding = selectOutstanding({ assets, submitted, today })
      if (outstanding.length === 0) {
        results.push({ locationId: settings.location_id, overdue: 0, pushed: false })
        continue
      }

      // sendPushToRolesAtLocation has no dedup; sendPushOnce dedups but
      // takes user ids, not roles — resolve the recipients first, then
      // dedup on (location, day) so a Vercel retry on the same day is a
      // no-op while tomorrow's run still fires.
      const ids = await resolveRoleRecipientIds(db, settings.location_id, ROLES)
      if (ids.length) {
        await sendPushOnce(db, `equip-overdue:${settings.location_id}:${today}`, ids, {
          title: 'Equipment inspections not done',
          body: buildOverdueBody(outstanding),
          data: { type: 'equipment_inspection_overdue' },
          // Registered in MOBILE_PERMISSIONS — an unregistered category
          // resolves false for every role but master.
          category: 'notify_inspection_overdue',
        })
      }

      await logAuditEvent({
        category: 'business',
        action: 'equipment.inspection_overdue',
        actor: null,
        target: { resource: `location/${settings.location_id}` },
        locationId: settings.location_id,
        details: { overdue_count: outstanding.length, today },
      })
      results.push({ locationId: settings.location_id, overdue: outstanding.length, pushed: ids.length > 0 })
    } catch (err) {
      logWarn('equipment-cron', 'sweep failed for location', {
        locationId: settings.location_id, error: err.message,
      })
      results.push({ locationId: settings.location_id, error: err.message })
    }
  }

  await stampHeartbeat('equipment-inspection-sweep')
  return NextResponse.json({ success: true, data: { today, locations: results } })
}
