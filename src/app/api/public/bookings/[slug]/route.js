import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'

// GET /api/public/bookings/:slug — Public: Calendly booking-type
// details + form fields. No auth required — this powers the public
// booking page at /book/[slug].
//
// Joins the parent location for name + address + timezone, so the
// BookingWidget can render a proper "where + when" sidebar without
// a second round-trip. branding (logo) is fetched from a separate
// public endpoint by the widget itself, so we don't ship signed-URL
// state through this response.
//
// PATH HISTORY: lived at /api/public/events/[slug] until the events
// expansion (E3 / commit 6f6911a) — the multi-kind events feature
// claimed the /api/public/events/* prefix for race / workshop /
// seminar / open_day / masterclass signups. Calendly templates moved
// to /api/public/bookings/* to mirror the operator-side relocation
// from /events to /bookings/event-types (E2 / commit 2d5c779). No
// back-compat rewrite — the only consumer was BookingWidget itself,
// updated in the same commit.
export async function GET(request, props) {
  const params = await props.params;
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
    return NextResponse.json({ success: false, error: 'Booking type not found' }, { status: 404 })
  }

  return NextResponse.json({ success: true, data })
}
