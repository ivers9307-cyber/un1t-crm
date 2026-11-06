// PIPEBUILD.2c — GET /api/locations/[id]/stages: the stages of every ENABLED
// board at a studio (not archived), ordered by board then stage, so a UI can
// show a board built in the editor (name, colour, role) with no code change.
//
// Service-role read, so access is enforced here: another studio is a 404, and
// any member may read — this mirrors the pipeline_stages_select RLS policy.
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccessOr404 } from '@/lib/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const PAGE = 1000

export async function GET(request, { params }) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  const { id: locationId } = await params
  const guard = assertLocationAccessOr404(user, locationId)
  if (guard) return guard

  const unreadable = () =>
    NextResponse.json({ success: false, error: 'Could not read stages' }, { status: 503 })

  const db = createServerClient()
  const { data: boards, error: boardsError } = await db
    .from('pipelines')
    .select('id, key, name, display_order')
    .eq('location_id', locationId)
    .eq('enabled', true)
    .order('display_order', { ascending: true })
    .range(0, PAGE - 1)
  if (boardsError) return unreadable()
  const boardRows = boards || []
  if (boardRows.length === 0) return NextResponse.json({ success: true, data: { stages: [] } })

  const { data: stages, error: stagesError } = await db
    .from('pipeline_stages')
    .select('pipeline_id, slug, name, color, stage_role, role_config, is_dormant, display_order')
    .eq('location_id', locationId)
    .in('pipeline_id', boardRows.map((b) => b.id))
    .eq('archived', false)
    .order('display_order', { ascending: true })
    .range(0, PAGE - 1)
  if (stagesError) return unreadable()

  const out = []
  for (const b of boardRows) {
    for (const s of (stages || []).filter((r) => r.pipeline_id === b.id)) {
      out.push({
        slug: s.slug,
        name: s.name,
        color: s.color,
        stage_role: s.stage_role,
        role_config: s.role_config,
        is_dormant: s.is_dormant === true,
        display_order: s.display_order,
        board_key: b.key,
        board_name: b.name,
      })
    }
  }
  return NextResponse.json({ success: true, data: { stages: out } })
}
