// EQUIP-MAINT.2 — open (or resume) the inspection for an asset's
// current cycle.
//
// Lazily created on first open so an abandoned walk-round leaves a
// draft with ticks, not nothing — and so nothing is pre-generated for
// assets nobody inspects.
//
// Idempotent by construction: unique (equipment_id, due_on) means a
// double-tap returns the same draft rather than minting a second.

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { getEquipment, getType, getDraftFor, insertDraft } from '@/lib/equipment-db'
import { buildDraftRow } from '@/lib/equipment-inspections'
import { EQUIPMENT_STATUS } from '@/lib/equipment'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const POST = withAuth(
  { permission: 'equipment_inspect', location: true },
  async ({ db, user, locationId, params }) => {
    const asset = await getEquipment(db, params?.id)
    // 404 not 403 — ids must not be enumerable.
    if (!asset || asset.location_id !== locationId) {
      return NextResponse.json({ success: false, error: 'Not found.' }, { status: 404 })
    }
    if (asset.status !== EQUIPMENT_STATUS.IN_SERVICE) {
      return NextResponse.json(
        { success: false, error: 'This equipment is not in service.' },
        { status: 409 }
      )
    }

    const existing = await getDraftFor(db, { equipmentId: asset.id, dueOn: asset.next_due_on })
    if (existing) {
      if (existing.status === 'submitted') {
        return NextResponse.json(
          { success: false, error: 'This inspection has already been submitted.' },
          { status: 409 }
        )
      }
      return NextResponse.json({ success: true, data: existing })
    }

    const type = await getType(db, asset.type_id)
    if (!type) {
      return NextResponse.json({ success: false, error: 'Equipment type not found.' }, { status: 404 })
    }

    let row
    try {
      row = buildDraftRow({ asset, type, inspectorId: user.id })
    } catch (err) {
      // No checklist items on the type — an operator setup gap, not a
      // server fault. Say what to do about it.
      return NextResponse.json(
        { success: false, error: `${err.message} Add checks in Equipment setup first.` },
        { status: 409 }
      )
    }

    let draft
    try {
      draft = await insertDraft(db, row)
    } catch (err) {
      // Lost a race on unique (equipment_id, due_on) — the other
      // request won, so return its draft rather than erroring.
      if (err?.code === '23505') {
        const won = await getDraftFor(db, { equipmentId: asset.id, dueOn: asset.next_due_on })
        if (won) return NextResponse.json({ success: true, data: won })
      }
      throw err
    }

    return NextResponse.json({ success: true, data: draft })
  }
)
