import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'

// GET /api/public/events/:slug — Public: event type details + form fields.
// No auth required — this powers the public booking page.
//
// Joins the parent location for name + address + timezone, so the
// redesigned BookingWidget can render a proper "where + when" sidebar
// without a second round-trip. branding (logo) is fetched from a
// separate public endpoint by the widget itself, so we don't ship
// signed-URL state through this response.
export async function GET(request, { params }) {
  const db = createServerClient()

  const { data, error } = await db.from('event_types')
    .select(`
      id, name, slug, description, duration_minutes, color,
      availability, buffer_minutes, max_advance_days, custom_fields,
      location_id,
      locations:location_id ( id, name, address, timezone )
    `)
    .eq('slug', params.slug)
    .eq('active', true)
    .single()

  if (error || !data) {
    return NextResponse.json({ success: false, error: 'Event not found' }, { status: 404 })
  }

  return NextResponse.json({ success: true, data })
}
