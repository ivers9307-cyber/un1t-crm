// EQUIP-MAINT.1 — a single asset: read, edit, retire.
//
// 404 not 403 on a cross-location id.
//
// DELETE retires (status='retired'), never hard-deletes: the
// compliance log references the asset with `on delete restrict`, so a
// hard delete would 500 once it has inspection history.
//
// Manual status changes are allowed here (kit pulled off the floor
// outside an inspection). That path leaves out_of_service_issue_id
// null, so the PR 2 clear-on-resolve hook has nothing to act on and
// the asset must be returned to service by hand — resolving an
// unrelated issue must never silently put broken kit back out.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withAuth } from '@/lib/with-auth'
import { getEquipment, updateEquipment, getType } from '@/lib/equipment-db'
import { EQUIPMENT_STATUS } from '@/lib/equipment'
import { logAuditEvent } from '@/lib/audit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

const PatchEquipmentBody = z.object({
  typeId: z.string().min(1).optional(),
  name: z.string().trim().min(1).max(100).optional(),
  assetTag: z.string().trim().max(50).optional().nullable(),
  serialNumber: z.string().trim().max(100).optional().nullable(),
  manufacturer: z.string().trim().max(100).optional().nullable(),
  zone: z.string().trim().max(100).optional().nullable(),
  purchaseDate: z.string().regex(DATE_RE).optional().nullable(),
  notes: z.string().trim().max(2000).optional().nullable(),
  nextDueOn: z.string().regex(DATE_RE).optional(),
  status: z.enum([EQUIPMENT_STATUS.IN_SERVICE, EQUIPMENT_STATUS.OUT_OF_SERVICE]).optional(),
})

export const GET = withAuth(
  { permission: 'equipment_inspect', location: true },
  async ({ db, locationId, params }) => {
    const asset = await getEquipment(db, params?.id)
    if (!asset || asset.location_id !== locationId) {
      return NextResponse.json({ success: false, error: 'Not found.' }, { status: 404 })
    }
    return NextResponse.json({ success: true, data: asset })
  }
)

export const PATCH = withAuth(
  { permission: 'equipment_admin', location: true, schema: PatchEquipmentBody },
  async ({ db, locationId, params, input, user }) => {
    const existing = await getEquipment(db, params?.id)
    if (!existing || existing.location_id !== locationId) {
      return NextResponse.json({ success: false, error: 'Not found.' }, { status: 404 })
    }
    if (existing.status === EQUIPMENT_STATUS.RETIRED) {
      return NextResponse.json(
        { success: false, error: 'This asset is retired and cannot be edited.' },
        { status: 409 }
      )
    }

    const patch = {}
    if (input.name !== undefined) patch.name = input.name
    if (input.assetTag !== undefined) patch.asset_tag = input.assetTag || null
    if (input.serialNumber !== undefined) patch.serial_number = input.serialNumber || null
    if (input.manufacturer !== undefined) patch.manufacturer = input.manufacturer || null
    if (input.zone !== undefined) patch.zone = input.zone || null
    if (input.purchaseDate !== undefined) patch.purchase_date = input.purchaseDate || null
    if (input.notes !== undefined) patch.notes = input.notes || null
    if (input.nextDueOn !== undefined) patch.next_due_on = input.nextDueOn

    if (input.typeId !== undefined && input.typeId !== existing.type_id) {
      const type = await getType(db, input.typeId)
      if (!type || type.location_id !== locationId) {
        return NextResponse.json({ success: false, error: 'Equipment type not found.' }, { status: 404 })
      }
      // Re-typing deliberately leaves next_due_on alone — the new
      // type's checklist applies to the next inspection, its interval
      // from the next roll-forward. Same rule as editing an interval.
      patch.type_id = type.id
    }

    if (input.status !== undefined && input.status !== existing.status) {
      patch.status = input.status
      // A manual return to service also clears any issue link, so a
      // later resolve of that issue is a no-op rather than a surprise.
      patch.out_of_service_issue_id = null
    }

    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ success: false, error: 'Nothing to update.' }, { status: 400 })
    }

    let asset
    try {
      asset = await updateEquipment(db, existing.id, patch)
    } catch (err) {
      // Retired assets are excluded from equipment_asset_tag_idx (mig 469),
      // so this only ever collides with a LIVE asset at this location.
      if (err?.code === '23505') {
        return NextResponse.json(
          {
            success: false,
            error:
              'That asset tag is already in use by another piece of equipment here. ' +
              'Retiring the old one frees the tag.',
          },
          { status: 409 }
        )
      }
      throw err
    }

    await logAuditEvent({
      category: 'mutation',
      action: 'equipment.updated',
      actor: { id: user.id, full_name: user.full_name, email: user.email },
      target: { label: asset.name, resource: `equipment/${asset.id}` },
      locationId,
      details: { fields: Object.keys(patch) },
    })
    return NextResponse.json({ success: true, data: asset })
  }
)

export const DELETE = withAuth(
  { permission: 'equipment_admin', location: true },
  async ({ db, locationId, params, user }) => {
    const existing = await getEquipment(db, params?.id)
    if (!existing || existing.location_id !== locationId) {
      return NextResponse.json({ success: false, error: 'Not found.' }, { status: 404 })
    }

    const asset = await updateEquipment(db, existing.id, {
      status: EQUIPMENT_STATUS.RETIRED,
      out_of_service_issue_id: null,
    })
    await logAuditEvent({
      category: 'mutation',
      action: 'equipment.retired',
      actor: { id: user.id, full_name: user.full_name, email: user.email },
      target: { label: asset.name, resource: `equipment/${asset.id}` },
      locationId,
    })
    return NextResponse.json({ success: true, data: asset })
  }
)
