import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'

// GET /api/public/branding — Public endpoint for logo/favicon (no auth needed)
// Returns branding for the first active location (or specific location_id)
export async function GET(request) {
  const { searchParams } = new URL(request.url)
  const locationId = searchParams.get('location_id')
  const db = createServerClient()

  let query = db.from('company_settings').select('logo_url, favicon_url, company_name')

  if (locationId) {
    query = query.eq('location_id', locationId)
  }

  const { data } = await query.limit(1).single()

  return NextResponse.json({
    success: true,
    data: data || { logo_url: null, favicon_url: null, company_name: null },
  })
}
