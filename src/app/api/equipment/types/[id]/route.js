// EQUIP-MAINT.1 — edit or disable a single equipment type.
//
// 404 not 403 on a cross-location id, so ids cannot be enumerated
// (the standard rule for detail routes in this codebase).
//
// DELETE is a SOFT delete (enabled=false) and is refused while
// non-retired assets still point at the type — equipment.type_id is
// `on delete restrict`, so a hard delete would 500 anyway.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withAuth } from '@/lib/with-auth'
import { getType, updateType, countActiveAssetsOfType } from '@/lib/equipment-db'
import { validateItems, INTERVAL_WEEKS_MIN, INTERVAL_WEEKS_MAX } from '@/lib/equipment'
import { logAuditEvent } from '@/lib/audit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const PatchTypeBody = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  intervalWeeks: z.number().int().min(INTERVAL_WEEKS_MIN).max(INTERVAL_WEEKS_MAX).optional(),
  items: z.array(z.object({
    id: z.string().min(1),
    label: z.string().min(1),
    order: z.number().int().optional(),
  })).optional(),
  enabled: z.boolean().optional(),
})

export const PATCH = withAuth(
  { permission: 'equipment_admin', location: true, schema: PatchTypeBody },
  async ({ db, locationId, params, input, user }) => {
    const existing = await getType(db, params?.id)
    if (!existing || existing.location_id !== locationId) {
      return NextResponse.json({ success: false, error: 'Not found.' }, { status: 404 })
    }

    const patch = {}
    if (input.name !== undefined) patch.name = input.name
    if (input.enabled !== undefined) patch.enabled = input.enabled
    if (input.intervalWeeks !== undefined) patch.interval_weeks = input.intervalWeeks
    if (input.items !== undefined) {
      const check = validateItems(input.items)
      if (!check.ok) {
        return NextResponse.json({ success: false, error: check.error }, { status: 400 })
      }
      patch.items = check.items
    }

    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ success: false, error: 'Nothing to update.' }, { status: 400 })
    }

    // Changing interval_weeks deliberately does NOT touch existing
    // equipment.next_due_on — it applies from the next roll-forward.
    // Bulk recalculation is an explicit operator action, never a side
    // effect of saving a type.
    let type
    try {
      type = await updateType(db, existing.id, patch)
    } catch (err) {
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
      action: 'equipment.type_updated',
      actor: { id: user.id, full_name: user.full_name, email: user.email },
      target: { label: type.name, resource: `equipment_type/${type.id}` },
      locationId,
      details: { fields: Object.keys(patch) },
    })
    return NextResponse.json({ success: true, data: type })
  }
)

export const DELETE = withAuth(
  { permission: 'equipment_admin', location: true },
  async ({ db, locationId, params, user }) => {
    const existing = await getType(db, params?.id)
    if (!existing || existing.location_id !== locationId) {
      return NextResponse.json({ success: false, error: 'Not found.' }, { status: 404 })
    }

    const inUse = await countActiveAssetsOfType(db, existing.id)
    if (inUse > 0) {
      return NextResponse.json(
        { success: false, error: `${inUse} piece(s) of equipment still use this type. Retire or re-type them first.` },
        { status: 409 }
      )
    }

    const type = await updateType(db, existing.id, { enabled: false })
    await logAuditEvent({
      category: 'mutation',
      action: 'equipment.type_disabled',
      actor: { id: user.id, full_name: user.full_name, email: user.email },
      target: { label: type.name, resource: `equipment_type/${type.id}` },
      locationId,
    })
    return NextResponse.json({ success: true, data: type })
  }
)
