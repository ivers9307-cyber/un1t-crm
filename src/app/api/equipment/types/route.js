// EQUIP-MAINT.1 — equipment types: the checklist + interval that
// assets inherit.
//
// GET  → list (enabled only unless ?includeDisabled=1). Readable by
//        anyone who can inspect, since the walk-round needs the items.
// POST → create. equipment_admin only.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withAuth } from '@/lib/with-auth'
import { listTypes, insertType } from '@/lib/equipment-db'
import { validateItems, INTERVAL_WEEKS_MIN, INTERVAL_WEEKS_MAX } from '@/lib/equipment'
import { logAuditEvent } from '@/lib/audit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const CreateTypeBody = z.object({
  name: z.string().trim().min(1).max(100),
  intervalWeeks: z.number().int().min(INTERVAL_WEEKS_MIN).max(INTERVAL_WEEKS_MAX),
  items: z.array(z.object({
    id: z.string().min(1),
    label: z.string().min(1),
    order: z.number().int().optional(),
  })),
})

export const GET = withAuth(
  { permission: 'equipment_inspect', location: true },
  async ({ db, locationId, request }) => {
    const includeDisabled = new URL(request.url).searchParams.get('includeDisabled') === '1'
    const types = await listTypes(db, locationId, { includeDisabled })
    return NextResponse.json({ success: true, data: types })
  }
)

export const POST = withAuth(
  { permission: 'equipment_admin', location: true, schema: CreateTypeBody },
  async ({ db, locationId, input, user }) => {
    // Zod checks the shape; validateItems checks the domain rules
    // (unique ids, label bounds, count) and renumbers order.
    const check = validateItems(input.items)
    if (!check.ok) {
      return NextResponse.json({ success: false, error: check.error }, { status: 400 })
    }

    let type
    try {
      type = await insertType(db, {
        locationId,
        name: input.name,
        items: check.items,
        intervalWeeks: input.intervalWeeks,
      })
    } catch (err) {
      // unique (location_id, name)
      if (err?.code === '23505') {
        return NextResponse.json(
          { success: false, error: 'An equipment type with that name already exists here.' },
          { status: 409 }
        )
      }
      throw err
    }

    await logAuditEvent({
      category: 'mutation',
      action: 'equipment.type_created',
      actor: { id: user.id, full_name: user.full_name, email: user.email },
      // resource, NOT target.id — a type uuid in target.id silently
      // drops the audit row (FK to profiles).
      target: { label: type.name, resource: `equipment_type/${type.id}` },
      locationId,
      details: { interval_weeks: type.interval_weeks, item_count: check.items.length },
    })
    return NextResponse.json({ success: true, data: type })
  }
)
