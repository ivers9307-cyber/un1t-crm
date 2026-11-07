// PIPEBUILD.6-3 — GET /api/pipelines/[id]/report: how an offer board is doing.
//
//   → { funnel, conversion, revenue, followups, health }
//
// Same gate as GET /api/pipelines/[id]: a manager role or the sequence-builder
// permission at the board's studio, and another studio's board is a 404. Revenue
// comes only with the dashboard_business permission; built-in boards have no
// report. Read-only.
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccessOr404, hasRoleAtLocation } from '@/lib/auth'
import { MANAGER_ROLES, uuidLike } from '@/lib/schemas'
import { canBuildSequencesAt } from '@/lib/sequence-access'
import { hasPermissionForLocation } from '@/lib/permissions'
import { boardLocationId, getBoard } from '@/lib/pipeline-boards'
import { buildBoardReport } from '@/lib/pipeline-board-report'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const notFound = (error = 'Not found') => NextResponse.json({ success: false, error }, { status: 404 })
const failed = (r) => NextResponse.json({ success: false, error: r.error }, { status: r.status })

export async function GET(request, { params }) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  const { id: boardId } = await params
  if (!uuidLike.safeParse(boardId).success) return notFound()
  const db = createServerClient()
  const where = await boardLocationId(db, boardId)
  if (!where.ok) return where.status === 404 ? notFound() : failed(where)
  const { locationId } = where
  const guard = assertLocationAccessOr404(user, locationId)
  if (guard) return guard
  if (!hasRoleAtLocation(user, locationId, MANAGER_ROLES) && !canBuildSequencesAt(user, locationId)) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  const result = await getBoard(db, locationId, boardId)
  if (!result.ok) return result.status === 404 ? notFound() : failed(result)
  if (result.board.board_type == null) return notFound('Report is for offer boards')

  const includeRevenue = hasPermissionForLocation(user, locationId, 'dashboard_business') === true
  const report = await buildBoardReport(db, { board: result.board, locationId, nowMs: Date.now(), includeRevenue })
  return NextResponse.json({ success: true, data: report })
}
