// PIPEBUILD.5d — POST /api/pipelines/[id]/enable: switch a board on.
//
// Owner or master at the board's studio. The studio is read first (by id,
// service role), then assertLocationAccessOr404 on it, so another studio's
// board is a 404. Switching on resets baseline_at and stamps updated_at in the
// same compare-and-set write, so the first placement pass after it is silent
// (src/lib/pipeline-boards.js setBoardEnabled). Already on answers
// { board, unchanged: true }.
import { NextResponse } from 'next/server'
import { assertLocationAccessOr404, guardMasterOrOwner } from '@/lib/auth'
import { withAuth } from '@/lib/with-auth'
import { uuidLike } from '@/lib/schemas'
import { boardLocationId, setBoardEnabled } from '@/lib/pipeline-boards'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const notFound = () => NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
const failure = (r) => NextResponse.json(
  { success: false, error: r.error, ...(r.code ? { code: r.code } : {}), ...(r.issues ? { issues: r.issues } : {}) },
  { status: r.status },
)

// withAuth only signs the caller in: the board's studio is read from the row,
// then membership (404) and owner-or-master there (403), as before.
export const POST = withAuth({ permission: null, location: false }, async ({ user, db, params }) => {
  const boardId = params?.id
  if (!uuidLike.safeParse(boardId).success) return notFound()

  const where = await boardLocationId(db, boardId)
  if (!where.ok) return where.status === 404 ? notFound() : failure(where)
  const locationId = where.locationId
  const guard = assertLocationAccessOr404(user, locationId)
  if (guard) return guard
  const roleGuard = guardMasterOrOwner(user, locationId)
  if (roleGuard) {
    return NextResponse.json({ success: false, error: 'Only owners and masters can switch boards on or off.' }, { status: 403 })
  }

  const result = await setBoardEnabled(db, { locationId, boardId, enabled: true })
  if (!result.ok) return failure(result)
  return NextResponse.json({ success: true, data: { board: result.board, ...(result.unchanged ? { unchanged: true } : {}) } })
})
