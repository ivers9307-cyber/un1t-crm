// PIPEBUILD.5f — PUT /api/pipelines/[id]/followups/[stageId]: install, replace
// the wording of, or switch off one stage's follow-up on an offer board.
//
//   PUT { action: 'install'|'replace'|'off', pack_key, bodies? }
//     → { followup, created?, unchanged?, publish_error?, code? }
//
// The board's studio is read first (by id, service role), then
// assertLocationAccessOr404 on it, so another studio's board is a 404 exactly
// like a missing one. Who: owner or master at that studio, OR someone who may
// both build sequences and manage WhatsApp templates there. Built-in boards are
// 409. RAILS.1: installing a follow-up afresh (no row, or a rejected/off one)
// and switching one off are owner work; so is a replace over no row or a
// spent one (403 owner_only); the wording tier may
// change the wording of a follow-up already set up and install a draft. The
// pack must belong to the board's recipe and fit the stage (400
// pack_not_for_stage). The order of the writes (the old sequence stopped
// before the new one exists) lives in src/lib/pipeline-board-followups.js.
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccessOr404, guardMasterOrOwner } from '@/lib/auth'
import { followupActionSchema, uuidLike } from '@/lib/schemas'
import { canBuildSequencesAt } from '@/lib/sequence-access'
import { canManageWaTemplatesAt } from '@/lib/wa-template-access'
import { validateBody } from '@/lib/validate'
import { boardLocationId, getBoard } from '@/lib/pipeline-boards'
import { assertNotLegacyBoard } from '@/lib/pipeline-board-guard'
import { applyFollowupAction, packForStage, SPENT_STATES } from '@/lib/pipeline-board-followups'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const notFound = () => NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
const failure = (r) => NextResponse.json(
  { success: false, error: r.error, ...(r.code ? { code: r.code } : {}), ...(r.issues ? { issues: r.issues } : {}) },
  { status: r.status },
)

export async function PUT(request, { params }) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  const { id: boardId, stageId } = await params
  if (!uuidLike.safeParse(boardId).success || !uuidLike.safeParse(stageId).success) return notFound()

  const db = createServerClient()
  const where = await boardLocationId(db, boardId)
  if (!where.ok) return where.status === 404 ? notFound() : failure(where)
  const locationId = where.locationId
  const guard = assertLocationAccessOr404(user, locationId)
  if (guard) return guard
  const isOwner = guardMasterOrOwner(user, locationId) === null
  const canWord = canBuildSequencesAt(user, locationId) && canManageWaTemplatesAt(user, locationId)
  if (!isOwner && !canWord) {
    return NextResponse.json(
      { success: false, error: 'You need sequence-builder and WhatsApp template permissions at this studio to change follow-ups.' },
      { status: 403 },
    )
  }

  const validation = await validateBody(request, followupActionSchema)
  if (!validation.ok) return validation.response
  const { action, pack_key: packKey, bodies } = validation.data

  const read = await getBoard(db, locationId, boardId)
  if (!read.ok) return read.status === 404 ? notFound() : failure(read)
  const board = read.board
  const legacy = assertNotLegacyBoard(board)
  if (legacy) return legacy
  const stage = board.stages.find((s) => s.id === stageId)
  if (!stage) return notFound()
  const packCheck = packForStage(board, stage, packKey)
  if (!packCheck.ok) return failure(packCheck)

  // UNIQUE (stage_id, pack_key): at most one row.
  const row = (board.followups || []).find((f) => f.stage_id === stageId && f.pack_key === packKey) ?? null
  // A replace over a spent row is a fresh install too (old sequence stopped,
  // version + 1, a new Meta submission).
  const fresh = !row || SPENT_STATES.has(row.state)
  const ownerWork = action === 'off' || ((action === 'install' || action === 'replace') && fresh)
  if (ownerWork && !isOwner) {
    return NextResponse.json(
      { success: false, error: 'Only an owner can install or switch off a follow-up. You can change the wording of one that is already set up.', code: 'owner_only' },
      { status: 403 },
    )
  }

  const result = await applyFollowupAction(db, { user, board, stage, action, packKey, bodies, locationId })
  if (!result.ok) return failure(result)
  return NextResponse.json({
    success: true,
    data: {
      followup: result.followup,
      ...(result.created !== undefined ? { created: result.created } : {}),
      ...(result.unchanged ? { unchanged: true } : {}),
      ...(result.publishError ? { publish_error: result.publishError } : {}),
      ...(result.code ? { code: result.code } : {}),
    },
  })
}
