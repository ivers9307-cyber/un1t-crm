import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { authenticateApiKey, orgLocationIds } from '@/lib/api-auth'

// GET /api/bookings — List bookings (filterable)
export async function GET(request) {
  const auth = await authenticateApiKey(request)
  if (!auth.ok) return auth.response

  const db = createServerClient()
  const { searchParams } = new URL(request.url)

  let query = db.from('bookings')
    .select('*, event_types(name, color, slug), contacts(name, email)')
    .order('booking_date', { ascending: true })
    .order('start_time', { ascending: true })

  // APIKEYS.3 — per-org key: restrict to the org's locations. Legacy
  // shared key (orgId null) stays unscoped — unchanged.
  if (auth.orgId) {
    const locIds = await orgLocationIds(db, auth.orgId)
    query = query.in('location_id', locIds.length ? locIds : ['00000000-0000-0000-0000-000000000000'])
  }

  const eventId = searchParams.get('event_type_id')
  const status = searchParams.get('status')
  const dateFrom = searchParams.get('date_from')
  const dateTo = searchParams.get('date_to')
  const contactId = searchParams.get('contact_id')

  const locationId = searchParams.get('location_id')
  if (locationId) query = query.eq('location_id', locationId)
  if (eventId) query = query.eq('event_type_id', eventId)
  if (status) query = query.eq('status', status)
  if (dateFrom) query = query.gte('booking_date', dateFrom)
  if (dateTo) query = query.lte('booking_date', dateTo)
  if (contactId) query = query.eq('contact_id', contactId)

  const limit = parseInt(searchParams.get('limit') || '50')
  query = query.limit(limit)

  const { data, error } = await query
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })

  return NextResponse.json({ success: true, data })
}
