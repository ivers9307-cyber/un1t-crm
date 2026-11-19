// PIPEBUILD.5f — GET /api/locations/[id]/pipeline-entry-options?type=…&match=…
// The values the board builder offers for an offer board's entry rule at this
// studio (src/lib/pipeline-entry-options.js): plan codes, landing paths or
// landing pages for a trial purchase, the corporate promos, the lead sources,
// the studio's active Glofox memberships, or its tags.
//
//   → { options: [{ value, label, hint? }] }
//
// Service-role read, so access is enforced here: another studio is a 404, and
// a member needs a manager role or the sequence-builder permission AT this
// studio (the stage-coverage gate). An unknown type is a 400.
import { NextResponse } from 'next/server'
import { hasRoleAtLocation } from '@/lib/auth'
import { withAuth } from '@/lib/with-auth'
import { MANAGER_ROLES, entryOptionsQuerySchema } from '@/lib/schemas'
import { canBuildSequencesAt } from '@/lib/sequence-access'
import { listEntryOptions } from '@/lib/pipeline-entry-options'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Sequence builders or managers AT this studio.
const canBuildOrManage = (user, locationId) =>
  canBuildSequencesAt(user, locationId) || hasRoleAtLocation(user, locationId, MANAGER_ROLES)

export const GET = withAuth({ permission: null, location: 'param', allow: canBuildOrManage }, async ({ request, db, locationId }) => {
  const sp = new URL(request.url).searchParams
  const parsed = entryOptionsQuerySchema.safeParse({
    type: sp.get('type') ?? undefined,
    match: sp.get('match') ?? undefined,
  })
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: 'type is required', code: 'unknown_type' }, { status: 400 })
  }

  const result = await listEntryOptions(db, { locationId, type: parsed.data.type, match: parsed.data.match })
  if (!result.ok) {
    return NextResponse.json(
      { success: false, error: result.error, ...(result.code ? { code: result.code } : {}) },
      { status: result.status },
    )
  }
  return NextResponse.json({ success: true, data: { options: result.options } })
})
