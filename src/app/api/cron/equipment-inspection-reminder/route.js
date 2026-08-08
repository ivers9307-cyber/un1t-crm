// EQUIP-MAINT.3 — Vercel cron, daily 06:00 UTC.
//
// For each enabled location whose inspection weekday is today (Dublin),
// count what is due and push it to everyone holding equipment_inspect.
// Silent when the count is zero — a "nothing due" push trains people to
// ignore the channel.
//
// Per-location error isolation: one bad location never stops the loop.
// Push delivery is best-effort; sendPush returns counts and never throws.
//
// Auth: CRON_SECRET Bearer, same as every other cron.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { listEnabledSettings, listActiveEquipment, listSubmittedSince } from '@/lib/equipment-db'
import { isInspectionDay, selectOutstanding, buildReminderBody } from '@/lib/equipment-cron'
import { sendPushToRolesAtLocation } from '@/lib/push'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { dublinTodayStr } from '@/lib/dublin-time'
import { logAuditEvent } from '@/lib/audit'
import { logWarn } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const ROLES = ['owner', 'master', 'manager', 'head_coach', 'staff', 'reception']

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

      await sendPushToRolesAtLocation(settings.location_id, ROLES, {
        title: 'Equipment inspections due',
        body: buildReminderBody(outstanding),
        data: { type: 'equipment_inspection' },
        // Registered in MOBILE_PERMISSIONS — an unregistered category
        // resolves false for every role but master.
        category: 'notify_inspection_due',
      })

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
      results.push({ locationId: settings.location_id, error: err.message })
    }
  }

  await stampHeartbeat('equipment-inspection-reminder')
  return NextResponse.json({ success: true, data: { today, locations: results } })
}
