// EQUIP-MAINT.1 — the equipment register.
//
// GET  → all non-retired assets at the active location (?includeRetired=1
//        for the full history view), each with its type embedded.
// POST → register a new asset. equipment_admin only.
//
// next_due_on is computed server-side from the location's inspection
// weekday — never trusted from the client, or an asset could be
// registered permanently not-due.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withAuth } from '@/lib/with-auth'
import { listEquipment, insertEquipment, getType, getSettings } from '@/lib/equipment-db'
import { firstDueOn, EQUIPMENT_STATUS } from '@/lib/equipment'
import { dublinTodayStr } from '@/lib/dublin-time'
import { logAuditEvent } from '@/lib/audit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

const CreateEquipmentBody = z.object({
  typeId: z.string().min(1),
  name: z.string().trim().min(1).max(100),
  assetTag: z.string().trim().max(50).optional().nullable(),
  serialNumber: z.string().trim().max(100).optional().nullable(),
  manufacturer: z.string().trim().max(100).optional().nullable(),
  zone: z.string().trim().max(100).optional().nullable(),
  purchaseDate: z.string().regex(DATE_RE).optional().nullable(),
  notes: z.string().trim().max(2000).optional().nullable(),
  firstDueOn: z.string().regex(DATE_RE).optional().nullable(),
})

export const GET = withAuth(
  { permission: 'equipment_inspect', location: true },
  async ({ db, locationId, request }) => {
    const includeRetired = new URL(request.url).searchParams.get('includeRetired') === '1'
    const rows = await listEquipment(db, locationId, { includeRetired })
    return NextResponse.json({ success: true, data: rows })
  }
)

export const POST = withAuth(
  { permission: 'equipment_admin', location: true, schema: CreateEquipmentBody },
  async ({ db, locationId, input, user }) => {
    // The type must exist AND belong to this location — otherwise an
    // operator at one studio could attach an asset to another studio's
    // type. 404 rather than 403 so type ids stay unguessable.
    const type = await getType(db, input.typeId)
    if (!type || type.location_id !== locationId) {
      return NextResponse.json({ success: false, error: 'Equipment type not found.' }, { status: 404 })
    }
    if (!type.enabled) {
      return NextResponse.json(
        { success: false, error: 'That equipment type is disabled. Re-enable it first.' },
        { status: 409 }
      )
    }

    const settings = await getSettings(db, locationId)
    if (!settings) {
      // Without a settings row there is no inspection weekday to snap
      // to — firstDueOn falls back to `today`, and rollForward (which
      // owns every later reschedule) adds whole weeks from that date
      // and never receives inspectionDayOfWeek, so the wrong weekday
      // is preserved forever, not corrected at the next roll-forward.
      // Refuse the register rather than silently minting an
      // off-weekday asset.
      return NextResponse.json(
        { success: false, error: 'Set your studio inspection day before registering equipment.' },
        { status: 409 }
      )
    }
    const nextDueOn = firstDueOn({
      today: dublinTodayStr(),
      inspectionDayOfWeek: settings.inspection_day_of_week,
      explicitFirstDue: input.firstDueOn || null,
    })

    let asset
    try {
      asset = await insertEquipment(db, {
        location_id: locationId,
        type_id: type.id,
        name: input.name,
        asset_tag: input.assetTag || null,
        serial_number: input.serialNumber || null,
        manufacturer: input.manufacturer || null,
        zone: input.zone || null,
        purchase_date: input.purchaseDate || null,
        notes: input.notes || null,
        status: EQUIPMENT_STATUS.IN_SERVICE,
        next_due_on: nextDueOn,
      })
    } catch (err) {
      // equipment_asset_tag_idx: unique (location_id, asset_tag) where
      // asset_tag is not null AND status <> 'retired' (mig 469). Retiring
      // an asset RELEASES its tag, because the tag belongs to the label on
      // the wall, not to the machine — so the replacement can reuse it.
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
      action: 'equipment.created',
      actor: { id: user.id, full_name: user.full_name, email: user.email },
      target: { label: asset.name, resource: `equipment/${asset.id}` },
      locationId,
      details: { type_id: type.id, type_name: type.name, next_due_on: asset.next_due_on },
    })
    return NextResponse.json({ success: true, data: asset })
  }
)
