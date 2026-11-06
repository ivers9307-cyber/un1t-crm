// PIPEBUILD.1e — GET /api/locations/[id]/stage-coverage: each enabled board's
// stages with the live follow-ups aimed at them (src/lib/pipeline-stage-coverage.js).
// Feeds the sequence editor's stage pickers and the pipeline page's coverage strip.
//
// Service-role read, so access is enforced here: another studio is a 404, and a
// member needs the sequence-builder permission or a manager role AT this studio.
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccessOr404, hasRoleAtLocation } from '@/lib/auth'
import { MANAGER_ROLES } from '@/lib/schemas'
import { canBuildSequencesAt } from '@/lib/sequence-access'
import { loadStageCoverage } from '@/lib/pipeline-stage-coverage'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request, { params }) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  const { id: locationId } = await params
  const guard = assertLocationAccessOr404(user, locationId)
  if (guard) return guard
  if (!canBuildSequencesAt(user, locationId) && !hasRoleAtLocation(user, locationId, MANAGER_ROLES)) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  const db = createServerClient()
  const result = await loadStageCoverage(db, locationId)
  if (!result.ok) {
    return NextResponse.json({ success: false, error: 'Could not read stage coverage' }, { status: 503 })
  }
  return NextResponse.json({ success: true, data: { boards: result.boards } })
}
