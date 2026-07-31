// EQUIP-MAINT.2 — what is due for inspection at the active location.
//
// Computed, not pre-generated: one indexed comparison against
// equipment.next_due_on. Nothing to orphan when kit is retired or
// re-typed.

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { listDueEquipment, listOutOfServiceEquipment, getSettings } from '@/lib/equipment-db'
import { dublinTodayStr } from '@/lib/dublin-time'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const GET = withAuth(
  { permission: 'equipment_inspect', location: true },
  async ({ db, locationId }) => {
    const settings = await getSettings(db, locationId)
    // Dormant location: no settings row or switched off. Return an
    // explicit shape rather than an empty list, so the UI can say
    // "not set up" instead of "nothing due".
    if (!settings || !settings.enabled) {
      return NextResponse.json({
        success: true,
        data: { enabled: false, today: dublinTodayStr(), due: [], outOfService: [] },
      })
    }

    const today = dublinTodayStr()
    const [due, outOfService] = await Promise.all([
      listDueEquipment(db, locationId, today),
      listOutOfServiceEquipment(db, locationId),
    ])

    return NextResponse.json({
      success: true,
      data: { enabled: true, today, inspectionDayOfWeek: settings.inspection_day_of_week, due, outOfService },
    })
  }
)
