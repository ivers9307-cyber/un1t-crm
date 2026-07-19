// GET /api/public/bookings/:slug/availability?days=14
// Returns the calendar days (Europe/Dublin) that have ≥1 open slot, so the
// public booking UI can show ONLY bookable days instead of a static next-N-days
// list peppered with dead days. Public (display-safe), light rate limit since
// it runs per-day slot computations. Mirrors the auth posture of the sibling
// /slots route (no auth; event must be active).
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { checkRateLimit, getClientIp, rateLimitResponse } from '@/lib/rate-limit'
import { computeAvailableDays } from '@/lib/booking-slots'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request, props) {
  const params = await props.params
  const db = createServerClient()
  const ip = getClientIp(request)
  // SAAS-6: tenant-keyed (the booking-page slug) — one tenant's traffic
  // can never consume another tenant's window for the same IP.
  const limit = await checkRateLimit(db, `pubavail:${params.slug}:${ip}`, { max: 30, windowMs: 5 * 60_000 })
  if (!limit.allowed) return rateLimitResponse(limit, 'Too many requests. Please wait a moment.')

  const { searchParams } = new URL(request.url)
  const days = Math.min(Math.max(1, Number(searchParams.get('days')) || 14), 31)

  const { data: event } = await db.from('event_types')
    .select('id, duration_minutes, availability, buffer_minutes, max_advance_days')
    .eq('slug', params.slug).eq('active', true).maybeSingle()
  if (!event) return NextResponse.json({ success: false, error: 'Booking type not found' }, { status: 404 })

  const available = await computeAvailableDays(db, event, { days })
  return NextResponse.json({ success: true, data: { days: available } })
}
