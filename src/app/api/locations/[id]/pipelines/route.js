// PIPEBUILD.5d — GET/POST /api/locations/[id]/pipelines: a studio's boards.
//
//   GET  → { boards, can_edit, has_whatsapp }   every board, enabled or not, with its stages
//          (open-deal counts) and follow-ups (src/lib/pipeline-boards.js)
//   POST { name, recipe_key, config, priority? } → { board }, created OFF
//
// Service-role routes, so access is enforced here: another studio is a 404.
// Reading the setup needs a manager role or the sequence-builder permission
// AT this studio (the stage-coverage gate); creating needs owner or master at
// this studio (an org admin carries a synthetic owner role there).
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccessOr404, hasRoleAtLocation, guardMasterOrOwner } from '@/lib/auth'
import { MANAGER_ROLES, boardCreateSchema, uuidLike } from '@/lib/schemas'
import { canBuildSequencesAt } from '@/lib/sequence-access'
import { validateBody } from '@/lib/validate'
import { logError } from '@/lib/log'
import { locationsWithWhatsApp } from '@/lib/whatsapp-config'
import { listBoards, createBoard } from '@/lib/pipeline-boards'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const notFound = () => NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
const failure = (r) => NextResponse.json(
  { success: false, error: r.error, ...(r.code ? { code: r.code } : {}), ...(r.issues ? { issues: r.issues } : {}) },
  { status: r.status },
)

export async function GET(request, { params }) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  const { id: locationId } = await params
  if (!uuidLike.safeParse(locationId).success) return notFound()
  const guard = assertLocationAccessOr404(user, locationId)
  if (guard) return guard
  if (!hasRoleAtLocation(user, locationId, MANAGER_ROLES) && !canBuildSequencesAt(user, locationId)) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  const db = createServerClient()
  const result = await listBoards(db, locationId)
  if (!result.ok) return failure(result)
  const canEdit = guardMasterOrOwner(user, locationId) === null
  // Decoration for the recipe cards: null on a failed read, never a false "no number".
  let hasWhatsapp = null
  try {
    hasWhatsapp = (await locationsWithWhatsApp(db, [locationId])).has(locationId)
  } catch (e) {
    logError('pipelines', `has_whatsapp read failed: ${e.message}`)
  }
  return NextResponse.json({ success: true, data: { boards: result.boards, can_edit: canEdit, has_whatsapp: hasWhatsapp } })
}

export async function POST(request, { params }) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  const { id: locationId } = await params
  if (!uuidLike.safeParse(locationId).success) return notFound()
  const guard = assertLocationAccessOr404(user, locationId)
  if (guard) return guard
  const roleGuard = guardMasterOrOwner(user, locationId)
  if (roleGuard) {
    return NextResponse.json({ success: false, error: 'Only owners and masters can build boards.' }, { status: 403 })
  }

  const validation = await validateBody(request, boardCreateSchema)
  if (!validation.ok) return validation.response
  const body = validation.data

  const db = createServerClient()
  const result = await createBoard(db, {
    locationId,
    name: body.name,
    recipeKey: body.recipe_key,
    config: body.config,
    priority: body.priority,
    createdBy: user.id ?? null,
  })
  if (!result.ok) return failure(result)
  return NextResponse.json({ success: true, data: { board: result.board } }, { status: 201 })
}
