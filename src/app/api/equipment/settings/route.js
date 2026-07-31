// EQUIP-MAINT.1 — per-location inspection weekday + feature switch.
//
// GET  → the location's settings, or null if never configured.
// PUT  → upsert. equipment_admin only.
//
// withAuth handles 401 / 403 / no-active-location and gives us the
// service-role client. There is NO RLS on these tables (service-role
// routes bypass it entirely), so the location scope comes from
// user.activeLocation via withAuth — never from the request body.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withAuth } from '@/lib/with-auth'
import { getSettings, upsertSettings } from '@/lib/equipment-db'
import { logAuditEvent } from '@/lib/audit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const SettingsBody = z.object({
  inspectionDayOfWeek: z.number().int().min(0).max(6),
  enabled: z.boolean(),
})

export const GET = withAuth(
  { permission: 'equipment_inspect', location: true },
  async ({ db, locationId }) => {
    const settings = await getSettings(db, locationId)
    return NextResponse.json({ success: true, data: settings })
  }
)

export const PUT = withAuth(
  { permission: 'equipment_admin', location: true, schema: SettingsBody },
  async ({ db, locationId, input, user }) => {
    const data = await upsertSettings(db, locationId, {
      inspectionDayOfWeek: input.inspectionDayOfWeek,
      enabled: input.enabled,
    })
    await logAuditEvent({
      category: 'mutation',
      action: 'equipment.settings_updated',
      actor: { id: user.id, full_name: user.full_name, email: user.email },
      target: { label: 'Equipment settings', resource: `equipment_settings/${locationId}` },
      locationId,
      details: { inspection_day_of_week: data.inspection_day_of_week, enabled: data.enabled },
    })
    return NextResponse.json({ success: true, data })
  }
)
