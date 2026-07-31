// EQUIP-MAINT.2 — record one pass/fail mark on a draft inspection.
//
// One item per request, so a dropped connection loses one tick rather
// than the whole walk-round.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withAuth } from '@/lib/with-auth'
import { getInspection, updateInspection } from '@/lib/equipment-db'
import { mergeTick } from '@/lib/equipment-inspections'
import { RESULT_NOTE_MAX } from '@/lib/equipment'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const TickBody = z.object({
  itemId: z.string().min(1),
  state: z.enum(['pass', 'fail']),
  note: z.string().trim().max(RESULT_NOTE_MAX).optional().nullable(),
})

export const PATCH = withAuth(
  { permission: 'equipment_inspect', location: true, schema: TickBody },
  async ({ db, user, locationId, params, input }) => {
    const inspection = await getInspection(db, params?.id)
    if (!inspection || inspection.location_id !== locationId) {
      return NextResponse.json({ success: false, error: 'Not found.' }, { status: 404 })
    }
    if (inspection.status !== 'draft') {
      return NextResponse.json(
        { success: false, error: 'This inspection has already been submitted.' },
        { status: 409 }
      )
    }
    // The mark must correspond to an item in THIS run's snapshot —
    // otherwise a stale client could write keys that no longer exist.
    if (!inspection.items.some((it) => it.id === input.itemId)) {
      return NextResponse.json(
        { success: false, error: 'That check is not part of this inspection.' },
        { status: 400 }
      )
    }
    if (input.state === 'fail' && !input.note?.trim()) {
      return NextResponse.json(
        { success: false, error: 'A fault needs a short note describing the problem.' },
        { status: 400 }
      )
    }

    const results = mergeTick(inspection.results, {
      itemId: input.itemId,
      state: input.state,
      note: input.note?.trim() || undefined,
      at: new Date().toISOString(),
      by: user.id,
    })

    const updated = await updateInspection(db, inspection.id, { results })
    return NextResponse.json({ success: true, data: updated })
  }
)
