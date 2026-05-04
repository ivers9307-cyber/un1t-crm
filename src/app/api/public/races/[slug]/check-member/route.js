// POST /api/public/races/[slug]/check-member
//
// Live email-check used by the public race signup widget as the
// captain/team-member types. Returns:
//   { is_member: boolean, first_name: string|null }
//
// Privacy posture:
//   - Same response shape whether the email is unknown OR known-but-
//     not-a-member. Callers can't use this endpoint to enumerate
//     contacts or test membership for arbitrary emails (other than
//     learning the boolean answer for the email they typed).
//   - Rate-limited per IP (60/min) so even the boolean answer can't
//     be brute-forced at scale.
//
// No auth — this is a public-form helper.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { checkRateLimit, getClientIp, rateLimitResponse } from '@/lib/rate-limit'
import { validateBody } from '@/lib/validate'
import { validateMemberByEmail } from '@/lib/member-validation'

export const runtime = 'nodejs'

const Schema = z.object({
  email: z.string().email().max(320),
})

export async function POST(request, { params }) {
  const db = createServerClient()

  const ip = getClientIp(request)
  const limit = await checkRateLimit(db, `race-check-member:${ip}`, {
    max: 60,
    windowMs: 60_000,
  })
  if (!limit.allowed) {
    return rateLimitResponse(limit, 'Too many lookups. Please slow down.')
  }

  const validation = await validateBody(request, Schema)
  if (!validation.ok) return validation.response
  const { email } = validation.data

  // We need the race's location to scope the contact lookup. Reading
  // by slug also implicitly validates the race exists and is active.
  const { data: race } = await db
    .from('race_events')
    .select('id, location_id, member_pricing_enabled, members_only')
    .eq('slug', params.slug)
    .eq('active', true)
    .maybeSingle()

  if (!race) {
    return NextResponse.json({ success: false, error: 'Race not found' }, { status: 404 })
  }

  // If member pricing is disabled AND this isn't a members-only race,
  // there's no functional reason to check — short-circuit. Saves a
  // contacts query on a high-volume keystroke endpoint.
  if (!race.member_pricing_enabled && !race.members_only) {
    return NextResponse.json({
      success: true,
      data: { is_member: false, first_name: null, applicable: false },
    })
  }

  const result = await validateMemberByEmail({
    db,
    email,
    locationId: race.location_id,
  })

  return NextResponse.json({
    success: true,
    data: {
      is_member: result.is_member,
      first_name: result.is_member ? result.first_name : null,
      applicable: true,
    },
  })
}
