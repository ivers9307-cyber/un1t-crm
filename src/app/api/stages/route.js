import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { requireApiKeyOrManager, scopeQueryToOrg } from '@/lib/api-auth'

// GET /api/stages — List pipeline stages.
//
// Accepts either the n8n bearer token OR a manager+ cookie session
// — same dual-auth pattern as /api/contacts/[id]. The SequenceEditor
// uses this client-side (cookie) to populate the move_pipeline_stage
// step's stage-slug picker; n8n still hits it with the API key.
export async function GET(request) {
  const auth = await requireApiKeyOrManager(request)
  if (!auth.ok) return auth.response

  const db = createServerClient()
  const { searchParams } = new URL(request.url)
  let query = db.from('pipeline_stages').select('*').order('display_order')
  const locationId = searchParams.get('location_id')
  if (locationId) query = query.eq('location_id', locationId)
  // APIKEYS.3 — per-org key: restrict to the org's locations (no-op for
  // cookie callers + legacy shared key).
  query = await scopeQueryToOrg(query, db, auth.orgId)
  const { data, error } = await query

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  }

  return NextResponse.json({ success: true, data })
}
