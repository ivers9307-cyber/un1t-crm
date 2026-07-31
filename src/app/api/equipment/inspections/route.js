// EQUIP-MAINT.3 — the compliance log: every submitted inspection at
// the active location, newest first. This is the view you put in front
// of an insurer or an H&S auditor.
//
// Paginated: unlike the register, this grows without bound (60 assets
// on a fortnightly cycle is ~1,500 rows a year) and every .select()
// caps at 1000 rows regardless of .limit().
//
// Gated on equipment_admin rather than equipment_inspect: the log is
// an oversight surface, and PR 1 set the split as admin = owner +
// master.

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { listInspectionLog } from '@/lib/equipment-db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_LIMIT = 100

export const GET = withAuth(
  { permission: 'equipment_admin', location: true },
  async ({ db, locationId, request }) => {
    const url = new URL(request.url)
    const limit = Math.min(Number(url.searchParams.get('limit')) || 50, MAX_LIMIT)
    const offset = Math.max(Number(url.searchParams.get('offset')) || 0, 0)
    const equipmentId = url.searchParams.get('equipmentId') || null

    const { rows, total } = await listInspectionLog(db, locationId, { limit, offset, equipmentId })
    return NextResponse.json({ success: true, data: { rows, total, limit, offset } })
  }
)
