// POST /api/public/events/[slug]/waitlist — EVENT-WAITLIST.1
//
// Public, no auth: join the waitlist of a SOLD-OUT event from its signup page.
// Rate-limited like the register route (5 per 15 min per slug + IP). No
// honeypot or captcha (repo convention for public forms).
//
// Refuses (never adds a row) when the event:
//   - is not published, active and public           → 404 (same shape as a missing event)
//   - is in the past                                → 409 past
//   - is not taking registrations right now         → 409 closed
//   - has room in any time                          → 409 has_room ("book directly")
//
// 🔴 Answers only "you're on the list" or a refusal: never how many are
// waiting, never any capacity (Richard's rule). See src/lib/event-waitlist.js.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { checkRateLimit, getClientIp, rateLimitResponse } from '@/lib/rate-limit'
import { validateBody } from '@/lib/validate'
import { eventIsPublic } from '@/lib/host-events'
import { dublinTodayStr } from '@/lib/dublin-time'
import { joinWaitlist, loadEventHasRoom, registrationWindowOpen, WAITLIST_EVENT_COLUMNS } from '@/lib/event-waitlist'
import { logError } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const WaitlistJoinSchema = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().email().max(320),
  phone: z
    .string()
    .trim()
    .max(50)
    .refine((v) => v === '' || v.replace(/\D/g, '').length >= 7, 'Enter a valid phone number')
    .nullable()
    .optional(),
  headcount: z.number().int().min(1).max(50).optional(),
  consent: z.boolean().optional(),
})

const refuse = (status, code, error) => NextResponse.json({ success: false, error, code }, { status })

export async function POST(request, props) {
  const params = await props.params
  const db = createServerClient()

  const ip = getClientIp(request)
  const limit = await checkRateLimit(db, `waitlist:${params.slug}:${ip}`, { max: 5, windowMs: 15 * 60_000 })
  if (!limit.allowed) {
    return rateLimitResponse(limit, 'Too many attempts. Please wait a few minutes and try again.')
  }

  const validation = await validateBody(request, WaitlistJoinSchema)
  if (!validation.ok) return validation.response
  const body = validation.data

  // race_events.slug is unique (mig 451): at most one row.
  const { data: race, error: raceErr } = await db
    .from('race_events')
    .select(`${WAITLIST_EVENT_COLUMNS}, allowed_team_sizes`)
    .eq('slug', params.slug)
    .eq('active', true)
    .eq('status', 'published')
    .maybeSingle()
  if (raceErr) {
    logError('event-waitlist', 'public join: event read failed', { err: raceErr, slug: params.slug })
    return refuse(500, 'load_failed', 'Something went wrong. Please try again.')
  }
  if (!race || !eventIsPublic(race)) return refuse(404, 'not_found', 'Event not found')

  if (race.race_date && race.race_date < dublinTodayStr()) {
    return refuse(409, 'past', 'This event has already happened.')
  }
  if (!registrationWindowOpen(race)) {
    return refuse(409, 'closed', 'This event is not taking signups right now.')
  }
  if (body.headcount && Array.isArray(race.allowed_team_sizes) && race.allowed_team_sizes.length
      && !race.allowed_team_sizes.includes(body.headcount)) {
    return refuse(400, 'invalid_headcount', 'Pick one of the group sizes on offer.')
  }

  const { hasRoom, error: roomErr } = await loadEventHasRoom(db, race)
  if (roomErr) {
    logError('event-waitlist', 'public join: registrations read failed', { err: roomErr, raceId: race.id })
    return refuse(500, 'load_failed', 'Something went wrong. Please try again.')
  }
  if (hasRoom) return refuse(409, 'has_room', 'Spots are available, book directly.')

  const joined = await joinWaitlist(db, {
    race,
    name: body.name,
    email: body.email,
    phone: body.phone || null,
    headcount: body.headcount || 1,
    consent: body.consent,
    ip,
    source: 'public',
  })
  if (joined.error) {
    return refuse(500, 'write_failed', 'Could not add you to the waitlist. Please try again.')
  }
  return NextResponse.json({ success: true, data: { id: joined.row.id } })
}
