import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { authenticateApiKey } from '@/lib/api-auth'

// GET /api/locations — List all active locations
export async function GET(request) {
  const auth = await authenticateApiKey(request)
  if (!auth.ok) return auth.response

  const db = createServerClient()
  let query = db
    .from('locations')
    .select('id, name, slug, address, active, timezone, country')
    .eq('active', true)
    .order('name')
  // APIKEYS.3 — per-org key: only this org's locations (locations carries
  // organization_id directly). Legacy/cookie callers unchanged.
  if (auth.orgId) query = query.eq('organization_id', auth.orgId)
  const { data, error } = await query

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  }

  return NextResponse.json({ success: true, data })
}
