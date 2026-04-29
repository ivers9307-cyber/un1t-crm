import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { requireApiKey } from '@/lib/api-auth'

// POST /api/deals — Create a deal (replaces Pipedrive POST /v1/deals)
export async function POST(request) {
  const authError = requireApiKey(request)
  if (authError) return authError

  const body = await request.json()
  const db = createServerClient()

  // Look up stage by slug if stage_slug is provided instead of stage_id
  let stageId = body.stage_id
  if (body.stage_slug && !stageId) {
    const { data: stage } = await db.from('pipeline_stages').select('id').eq('slug', body.stage_slug).single()
    stageId = stage?.id
  }

  const { data, error } = await db.from('deals').insert({
    title: body.title,
    contact_id: body.contact_id,
    stage_id: stageId,
    status: body.status || 'open',
    value: body.value || 0,
    ...(body.location_id ? { location_id: body.location_id } : {}),
  }).select().single()

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  }

  return NextResponse.json({ success: true, data })
}
