// PIPEBUILD.1e — GET /api/locations/[id]/stage-coverage: each enabled board's
// stages with the live follow-ups aimed at them (src/lib/pipeline-stage-coverage.js).
// Feeds the sequence editor's stage pickers and the pipeline page's coverage strip.
//
// Service-role read, so access is enforced here: another studio is a 404, and a
// member needs the sequence-builder permission or a manager role AT this studio.
import { NextResponse } from 'next/server'
import { hasRoleAtLocation } from '@/lib/auth'
import { withAuth } from '@/lib/with-auth'
import { MANAGER_ROLES } from '@/lib/schemas'
import { canBuildSequencesAt } from '@/lib/sequence-access'
import { loadStageCoverage } from '@/lib/pipeline-stage-coverage'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Sequence builders or managers AT this studio.
const canBuildOrManage = (user, locationId) =>
  canBuildSequencesAt(user, locationId) || hasRoleAtLocation(user, locationId, MANAGER_ROLES)

export const GET = withAuth({ permission: null, location: 'param', allow: canBuildOrManage }, async ({ db, locationId }) => {
  const result = await loadStageCoverage(db, locationId)
  if (!result.ok) {
    return NextResponse.json({ success: false, error: 'Could not read stage coverage' }, { status: 503 })
  }
  return NextResponse.json({ success: true, data: { boards: result.boards } })
})
