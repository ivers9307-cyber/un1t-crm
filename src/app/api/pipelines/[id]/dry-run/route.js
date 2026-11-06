// PIPEBUILD.5e — POST /api/pipelines/[id]/dry-run: who would enter this board.
//
// Owner or master at the board's studio (studio read first, then
// assertLocationAccessOr404, so another studio's board is a 404). Runs the
// placement pass with dryRun:true, which never writes; a board that is off is
// included for this run only. Built-in boards answer 409. A failed run is 503.
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccessOr404, guardMasterOrOwner } from '@/lib/auth'
import { uuidLike } from '@/lib/schemas'
import { boardLocationId, getBoard, listBoards } from '@/lib/pipeline-boards'
import { assertNotLegacyBoard } from '@/lib/pipeline-board-guard'
import { reclassifyAllContacts } from '@/lib/pipeline-reclassify'
import { summariseBoardDryRun } from '@/lib/pipeline-board-dry-run'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const notFound = () => NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
const failure = (r) => NextResponse.json(
  { success: false, error: r.error, ...(r.code ? { code: r.code } : {}) },
  { status: r.status || 503 },
)

export async function POST(request, { params }) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  const { id: boardId } = await params
  if (!uuidLike.safeParse(boardId).success) return notFound()

  const db = createServerClient()
  const where = await boardLocationId(db, boardId)
  if (!where.ok) return where.status === 404 ? notFound() : failure(where)
  const locationId = where.locationId
  const guard = assertLocationAccessOr404(user, locationId)
  if (guard) return guard
  const roleGuard = guardMasterOrOwner(user, locationId)
  if (roleGuard) {
    return NextResponse.json({ success: false, error: 'Only owners and masters can dry-run a board.' }, { status: 403 })
  }

  const found = await getBoard(db, locationId, boardId)
  if (!found.ok) return found.status === 404 ? notFound() : failure(found)
  const board = found.board
  const legacy = assertNotLegacyBoard(board)
  if (legacy) return legacy

  const result = await reclassifyAllContacts(db, {
    locationId,
    dryRun: true,
    source: 'manual',
    userId: user.id,
    includeDisabledBoardIds: board.enabled ? [] : [board.id],
  })
  if (!result?.ok) {
    return NextResponse.json({ success: false, error: result?.error || 'The dry run could not be completed.' }, { status: 503 })
  }

  // Names for the overlap rows (built-in boards too); a failed read just
  // leaves the keys unnamed.
  const all = await listBoards(db, locationId)
  const names = all.ok ? Object.fromEntries(all.boards.map((b) => [b.key, b.name])) : {}

  return NextResponse.json({ success: true, data: summariseBoardDryRun(result, board, names) })
}
