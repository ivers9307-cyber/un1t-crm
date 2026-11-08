// /api/public/event-rating/[token] — HOSTPAGE.2
//
// The post-event rating page's API. The token (signed with the service-role
// key, 30 days, naming ONE registration and ONE event) is the only credential:
// a bad, expired or mismatched token, a UN1T event (host_id null), an inactive
// event, or a missing entry all answer the same 404.
//   GET  → { event: { name, date_label, host_name }, existing: { rating, comment } | null }
//   POST { rating 1–5, comment ≤600 } → stores ONE rating per registration
//        (UNIQUE in mig 823; a second is 409 already_rated) and answers it.
// Rate-limited per IP like the entry page. No auth — a personal link.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { checkRateLimit, getClientIp, rateLimitResponse } from '@/lib/rate-limit'
import { validateBody } from '@/lib/validate'
import { verifyRatingToken } from '@/lib/event-ratings'
import { eventDateLong } from '@/lib/event-day'
import { logWarn } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const RatingBodySchema = z.object({
  rating: z.number().int().min(1).max(5),
  comment: z.string().trim().max(600).optional().nullable(),
}).strict()

const notFound = () => NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })

/** The entry the token names, or null for every refusal (the caller answers 404). */
async function loadEntry(db, token) {
  const claim = verifyRatingToken(token, process.env.SUPABASE_SERVICE_ROLE_KEY || null)
  if (!claim) return null
  const { data, error } = await db
    .from('race_registrations')
    .select('id, status, race_event_id, contact_id, race:race_event_id ( id, name, race_date, host_id, active, host:event_hosts!host_id ( name ) )')
    .eq('id', claim.registrationId)
    .maybeSingle()
  if (error) {
    logWarn('event-rating', 'entry read failed', { err: error })
    return null
  }
  if (!data || data.race_event_id !== claim.eventId) return null
  if (!data.race?.host_id || data.race.active === false) return null
  return data
}

async function existingFor(db, registrationId) {
  const { data, error } = await db.from('event_ratings').select('rating, comment').eq('registration_id', registrationId).maybeSingle()
  if (error) logWarn('event-rating', 'rating read failed', { err: error, registrationId })
  return data ? { rating: data.rating, comment: data.comment ?? null } : null
}

async function gate(request, db) {
  const limit = await checkRateLimit(db, `rating:${getClientIp(request)}`, { max: 60, windowMs: 5 * 60_000 })
  return limit.allowed ? null : rateLimitResponse(limit)
}

export async function GET(request, props) {
  const { token } = await props.params
  const db = createServerClient()
  const limited = await gate(request, db)
  if (limited) return limited
  const entry = await loadEntry(db, token)
  if (!entry) return notFound()
  return NextResponse.json({
    success: true,
    data: {
      event: { name: entry.race.name, date_label: eventDateLong(entry.race.race_date), host_name: entry.race.host?.name || '' },
      existing: await existingFor(db, entry.id),
    },
  })
}

export async function POST(request, props) {
  const { token } = await props.params
  const db = createServerClient()
  const limited = await gate(request, db)
  if (limited) return limited
  const validation = await validateBody(request, RatingBodySchema)
  if (!validation.ok) return validation.response
  const entry = await loadEntry(db, token)
  if (!entry) return notFound()

  const comment = validation.data.comment?.trim() ? validation.data.comment.trim() : null
  const { data, error } = await db
    .from('event_ratings')
    .insert({ race_event_id: entry.race.id, registration_id: entry.id, host_id: entry.race.host_id, contact_id: entry.contact_id || null, rating: validation.data.rating, comment })
    .select('id, rating, comment')
    .single()
  if (error) {
    if (error.code === '23505') return NextResponse.json({ success: false, error: 'You have already rated this event.', code: 'already_rated' }, { status: 409 })
    logWarn('event-rating', 'rating write failed', { err: error, registrationId: entry.id })
    return NextResponse.json({ success: false, error: 'Could not save your rating — try again shortly.' }, { status: 500 })
  }
  return NextResponse.json({ success: true, data: { rating: data?.rating ?? validation.data.rating, comment: data?.comment ?? comment } })
}
