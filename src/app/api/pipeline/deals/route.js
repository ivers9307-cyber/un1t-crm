// GET /api/pipeline/deals?stage_id=&offset=&view= — one lazy page of deals for
// a single pipeline column (FEAT-PIPELINE-LAZY.1). The board ships only the
// first page per column server-side; this backs the per-column "Load more" so
// the client never receives all ≤10k open deals at once.
//
// Location-scoped: the stage must belong to the caller's active location, and
// the deals query filters location_id (service-role bypasses RLS).

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { logWarn } from '@/lib/log'
import { pipelineDealSelect, boardDealMapper, boardCardOptionsForModule, PIPELINE_PAGE_SIZE } from '@/lib/pipeline-board'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!hasPermission(user, 'pipeline')) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
  const locationId = user.activeLocation?.id
  if (!locationId) return NextResponse.json({ success: false, error: 'No active location' }, { status: 400 })

  const { searchParams } = new URL(request.url)
  const stageId = searchParams.get('stage_id')
  const offset = Math.max(0, parseInt(searchParams.get('offset') || '0', 10) || 0)
  // RETURNPIPE.1 — 'returning' deliberately falls through to the 'active'
  // field set: it is a live flow, so its cards need recent_bookings the same
  // way the funnel's do. Only 'dormant' ships the trimmed selection.
  const view = searchParams.get('view') === 'dormant' ? 'dormant' : 'active'
  if (!stageId) return NextResponse.json({ success: false, error: 'stage_id required' }, { status: 400 })

  const db = createServerClient()

  // Tenant scope: 404 (not 403) if the stage isn't at this location so ids
  // can't be enumerated across tenants.
  const { data: stage } = await db
    .from('pipeline_stages')
    .select('id, pipeline_id')
    .eq('id', stageId)
    .eq('location_id', locationId)
    .maybeSingle()
  if (!stage) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })

  // The stage's board decides whether cards carry the next-class badge and the
  // Glofox credit count (a un1t.online board has no Glofox bookings, and its
  // contacts' Glofox credits are another studio's). A stage with no readable
  // board keeps both, i.e. today's behaviour.
  let cardOptions = boardCardOptionsForModule(null)
  if (stage.pipeline_id) {
    const { data: pipeline, error: pipelineError } = await db
      .from('pipelines')
      .select('module')
      .eq('id', stage.pipeline_id)
      .eq('location_id', locationId)
      .maybeSingle()
    if (pipelineError) {
      // The board only decides the card options. Fail open (badge and credit
      // count kept, today's behaviour) rather than 500 the whole Load-more
      // page; ids only, no error text.
      logWarn('pipeline-deals', 'board read failed; badge kept', { stageId, locationId })
    } else {
      cardOptions = boardCardOptionsForModule(pipeline?.module)
    }
  }

  const { data, error } = await db
    .from('deals')
    .select(pipelineDealSelect(view))
    .eq('status', 'open')
    .eq('location_id', locationId)
    .eq('stage_id', stageId)
    .order('created_at', { ascending: false })
    .range(offset, offset + PIPELINE_PAGE_SIZE - 1)

  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })

  return NextResponse.json({ success: true, deals: (data || []).map(boardDealMapper(cardOptions)) })
}
