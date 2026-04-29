import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { requireApiKey } from '@/lib/api-auth'

// POST /api/contacts — Create a contact (replaces Pipedrive POST /v1/persons)
export async function POST(request) {
  const authError = requireApiKey(request)
  if (authError) return authError

  const body = await request.json()
  const db = createServerClient()

  const { data, error } = await db.from('contacts').insert({
    name: body.name,
    first_name: body.first_name || body.name?.split(' ')[0],
    last_name: body.last_name || body.name?.split(' ').slice(1).join(' '),
    email: body.email,
    phone: body.phone,
    label: body.label,
    glofox_member_id: body.glofox_member_id,
    trial_credits_remaining: body.trial_credits_remaining ?? 3,
    lead_source: body.lead_source,
    lead_status: body.lead_status || 'active_trial',
    lead_created_at: body.lead_created_at || new Date().toISOString(),
    ...(body.location_id ? { location_id: body.location_id } : {}),
  }).select().single()

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  }

  // Return in a shape similar to Pipedrive for easy n8n migration
  return NextResponse.json({ success: true, data })
}

// GET /api/contacts — List contacts with optional filters
// Query params: lead_status, lead_source, limit, offset
// Replaces Pipedrive GET /v1/persons?filter_id=X
export async function GET(request) {
  const authError = requireApiKey(request)
  if (authError) return authError

  const { searchParams } = new URL(request.url)
  const db = createServerClient()

  let query = db.from('contacts').select('*')

  // Location filter
  const locationId = searchParams.get('location_id')
  if (locationId) query = query.eq('location_id', locationId)

  // Filters
  const status = searchParams.get('lead_status')
  if (status) query = query.eq('lead_status', status)

  const source = searchParams.get('lead_source')
  if (source) query = query.eq('lead_source', source)

  // Credits filter (replaces Pipedrive saved filter for active trials)
  const minCredits = searchParams.get('min_credits')
  if (minCredits) query = query.gt('trial_credits_remaining', parseInt(minCredits))

  // Pagination
  const limit = parseInt(searchParams.get('limit') || '100')
  const offset = parseInt(searchParams.get('offset') || '0')
  query = query.range(offset, offset + limit - 1).order('created_at', { ascending: false })

  const { data, error, count } = await query

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  }

  return NextResponse.json({ success: true, data })
}
