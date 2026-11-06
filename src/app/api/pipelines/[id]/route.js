// PIPEBUILD.5d — GET/PATCH /api/pipelines/[id]: one board.
//
//   GET   → { board, can_edit, can_edit_wording }
//   PATCH { name?, priority?, config? } → { board }
//
// The board's studio is read first (by id, service role), then
// assertLocationAccessOr404 on it, so another studio's board is a 404 exactly
// like a missing one. GET needs a manager role or the sequence-builder
// permission at that studio; PATCH needs owner or master there. The entry
// rule, the stages, the day counts and the priority change only while the
// board is off (src/lib/pipeline-boards.js answers 409 switch_off_first).
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccessOr404, hasRoleAtLocation, guardMasterOrOwner } from '@/lib/auth'
import { MANAGER_ROLES, boardPatchSchema, uuidLike } from '@/lib/schemas'
import { canBuildSequencesAt } from '@/lib/sequence-access'
import { canManageWaTemplatesAt } from '@/lib/wa-template-access'
import { validateBody } from '@/lib/validate'
import { boardLocationId, getBoard, updateBoard } from '@/lib/pipeline-boards'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const notFound = () => NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
const failure = (r) => NextResponse.json(
  { success: false, error: r.error, ...(r.code ? { code: r.code } : {}), ...(r.issues ? { issues: r.issues } : {}) },
  { status: r.status },
)

// The board's studio, with the caller's membership there checked (404 otherwise).
async function resolveBoard(user, boardId, db) {
  if (!uuidLike.safeParse(boardId).success) return { response: notFound() }
  const where = await boardLocationId(db, boardId)
  if (!where.ok) return { response: where.status === 404 ? notFound() : failure(where) }
  const guard = assertLocationAccessOr404(user, where.locationId)
  if (guard) return { response: guard }
  return { locationId: where.locationId }
}

export async function GET(request, { params }) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  const { id: boardId } = await params
  const db = createServerClient()
  const resolved = await resolveBoard(user, boardId, db)
  if (resolved.response) return resolved.response
  const { locationId } = resolved
  if (!hasRoleAtLocation(user, locationId, MANAGER_ROLES) && !canBuildSequencesAt(user, locationId)) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  const result = await getBoard(db, locationId, boardId)
  if (!result.ok) return failure(result)
  const canEdit = guardMasterOrOwner(user, locationId) === null
  const canEditWording = canEdit || (canBuildSequencesAt(user, locationId) && canManageWaTemplatesAt(user, locationId))
  return NextResponse.json({ success: true, data: { board: result.board, can_edit: canEdit, can_edit_wording: canEditWording } })
}

export async function PATCH(request, { params }) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  const { id: boardId } = await params
  const db = createServerClient()
  const resolved = await resolveBoard(user, boardId, db)
  if (resolved.response) return resolved.response
  const { locationId } = resolved
  const roleGuard = guardMasterOrOwner(user, locationId)
  if (roleGuard) {
    return NextResponse.json({ success: false, error: 'Only owners and masters can change boards.' }, { status: 403 })
  }

  const validation = await validateBody(request, boardPatchSchema)
  if (!validation.ok) return validation.response

  const result = await updateBoard(db, { locationId, boardId, patch: validation.data })
  if (!result.ok) return failure(result)
  return NextResponse.json({ success: true, data: { board: result.board } })
}
