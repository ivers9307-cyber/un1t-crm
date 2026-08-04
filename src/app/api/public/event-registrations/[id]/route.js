// GET /api/public/event-registrations/[id]
//
// Public — no auth. Read-only summary of a single registration for
// the post-payment confirmation page (/race/[slug]/confirmed).
//
// Privacy: returns ONLY the team-visible fields (team name, size,
// wave, member roster names + role + verified flag). Does NOT
// return the captain's email or phone — even though the buyer just
// went through checkout, exposing PII via a UUID-keyed public route
// would leak if the URL got shared.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { signCheckinToken } from '@/lib/event-checkin-tokens'
import { checkRateLimit, getClientIp, rateLimitResponse } from '@/lib/rate-limit'

export const runtime = 'nodejs'

export async function GET(request, props) {
  const params = await props.params;
  const db = createServerClient()

  // Id-enumeration guard (audit H2a). Keyed on IP alone — an enumerator varies
  // the UUID, so a per-id bucket would never fill (deposit-view convention).
  // Sized 60-per-5-min, double the usual 30: RaceConfirmedPage polls this at
  // 2s for up to 20s while the payment webhook lands (≈11 requests per buyer),
  // so a couple of buyers behind one NAT must fit comfortably. Fails open
  // inside checkRateLimit so a limiter outage never hides a confirmation.
  const ip = getClientIp(request)
  const limit = await checkRateLimit(db, `event-reg:${ip}`, { max: 60, windowMs: 5 * 60_000 })
  if (!limit.allowed) return rateLimitResponse(limit)

  const { data, error } = await db
    .from('race_registrations')
    .select(`
      id, status, registered_at, team_composition,
      race:race_event_id (
        id, name, slug, race_date, location_id,
        locations:location_id ( name, address )
      ),
      wave:wave_id ( id, start_time, label ),
      teams:team_id ( id, name, size,
        team_members ( id, name, role, is_member ) )
    `)
    .eq('id', params.id)
    .maybeSingle()

  if (error || !data) {
    return NextResponse.json({ success: false, error: 'Registration not found' }, { status: 404 })
  }

  // On-screen check-in QR — mint the SAME per-attendee signed token the
  // confirmation email already uses (event-checkin-tokens + the public
  // checkin-qr PNG route), so the buyer can show their pass on this page
  // too. Same exposure as the email they just received; the token only
  // opens a staff-gated scan page (identity, not authorisation). Minted
  // only once the registration is confirmed (paid) — never for pending.
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY || null
  const eventId = data.race?.id || null
  const canMintQr = data.status === 'confirmed' && !!secret && !!eventId
  const withQr = (rawMembers) => (rawMembers || []).map((m) => {
    const base = { id: m.id, name: m.name, role: m.role, is_member: m.is_member }
    if (!canMintQr || !m?.id) return base
    const token = signCheckinToken({ eventId, registrationId: data.id, memberId: m.id }, secret)
    return { ...base, qr_url: `/api/public/events/checkin-qr?t=${encodeURIComponent(token)}` }
  })
  const team = data.teams
    ? { id: data.teams.id, name: data.teams.name, size: data.teams.size, team_members: withQr(data.teams.team_members) }
    : null

  return NextResponse.json({
    success: true,
    data: {
      id: data.id,
      status: data.status,
      registered_at: data.registered_at,
      team_composition: data.team_composition,
      race: data.race,
      wave: data.wave,
      team,
    },
  })
}
