import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getLocationBranding } from '@/lib/location-branding'

// GET /api/public/branding — Public endpoint for logo/favicon (no auth needed)
// Returns branding for the first active location (or specific location_id)
export async function GET(request) {
  const { searchParams } = new URL(request.url)
  const locationId = searchParams.get('location_id')
  const db = createServerClient()

  if (locationId) {
    const b = await getLocationBranding(db, locationId)
    return NextResponse.json({
      success: true,
      data: { logo_url: b.logoUrl, favicon_url: b.faviconUrl, company_name: b.companyName },
    })
  }

  // Anonymous visitor (login screen, no location yet) — first configured row.
  const { data } = await db
    .from('company_settings')
    .select('logo_url, favicon_url, company_name')
    .limit(1)
    .single()

  return NextResponse.json({
    success: true,
    data: data || { logo_url: null, favicon_url: null, company_name: null },
  })
}
