// PIPEBUILD.6-3 — GET /api/pipelines/[id]/report: how an offer board is doing.
//
//   → { funnel, conversion, revenue, followups, health }
//
// Same gate as GET /api/pipelines/[id]: a manager role or the sequence-builder
// permission at the board's studio, and another studio's board is a 404. Revenue
// comes only with the dashboard_business permission; built-in boards have no
// report. Read-only.
import { NextResponse } from 'next/server'
import { assertLocationAccessOr404, hasRoleAtLocation } from '@/lib/auth'
import { withAuth } from '@/lib/with-auth'
import { MANAGER_ROLES, uuidLike } from '@/lib/schemas'
import { canBuildSequencesAt } from '@/lib/sequence-access'
import { hasPermissionForLocation } from '@/lib/permissions'
import { boardLocationId, getBoard } from '@/lib/pipeline-boards'
import { buildBoardReport } from '@/lib/pipeline-board-report'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const notFound = (error = 'Not found') => NextResponse.json({ success: false, error }, { status: 404 })
const failed = (r) => NextResponse.json({ success: false, error: r.error }, { status: r.status })

// withAuth only signs the caller in: the board's studio is read from the row,
// then membership (404) and the manager-or-builder check there (403), as before.
export const GET = withAuth({ permission: null, location: false }, async ({ user, db, params }) => {
  const boardId = params?.id
  if (!uuidLike.safeParse(boardId).success) return notFound()
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
})
