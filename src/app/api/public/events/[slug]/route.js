// GET /api/public/events/[slug]
//
// Public — no auth. Race details + allowed_team_sizes for the public
// signup form at /race/[slug]. Joins the parent location for the
// info sidebar. Mirrors the shape of /api/public/events/[slug].

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { loadForMode } from '@/lib/event-signups'
import { eventIsPublic } from '@/lib/host-events'
import { isHostAnchorLocation, pickAudienceVenueName } from '@/lib/event-comms-location'
import { checkRateLimit, getClientIp, rateLimitResponse } from '@/lib/rate-limit'
import { getOrgBrandName } from '@/lib/location-branding'

export const runtime = 'nodejs'
// Force-dynamic so wave / fee edits in the operator UI show up
// immediately on the public page — Next.js' default caching for
// route handlers would otherwise hold stale data for a few minutes.
export const dynamic = 'force-dynamic'

export async function GET(request, props) {
  const params = await props.params;
  const db = createServerClient()

  // Public-browse abuse limiter (audit H2a) — 60-per-5-min per slug+IP: the
  // signup page loads this once (plus reloads while a buyer dithers), so a
  // human never gets near the cap; it only bites scripted scraping of an
  // endpoint that runs per-wave capacity COUNTs. Slug-keyed per SAAS-6.
  // Fails open inside checkRateLimit.
  const ip = getClientIp(request)
  const limit = await checkRateLimit(db, `pubrace:${params.slug}:${ip}`, { max: 60, windowMs: 5 * 60_000 })
  if (!limit.allowed) return rateLimitResponse(limit)

  const { data, error } = await db
    .from('race_events')
    .select(`
      id, name, slug, description, race_date, kind, capacity_mode,
      registration_opens_at, registration_closes_at,
      allowed_team_sizes, location_id,
      venue_name, venue_address,
      member_pricing_enabled, member_fee_cents, non_member_fee_cents,
      members_only, payment_currency,
      hero_image_url, accent_hex, active, status,
      waves:race_waves ( id, start_time, capacity, label, display_order ),
      locations:location_id ( id, name, address, timezone, is_host_anchor, organization_id ),
      host:event_hosts!host_id ( name )
    `)
    .eq('slug', params.slug)
    .eq('active', true)
    .eq('status', 'published')
    .single()

  if (error || !data) {
    return NextResponse.json({ success: false, error: 'Race not found' }, { status: 404 })
  }

  // Belt-and-suspenders: even with the status=published DB filter above,
  // never surface a non-public (unapproved host) event. Same 404 shape
  // so an unpublished event is indistinguishable from a missing one.
  if (!eventIsPublic(data)) {
    return NextResponse.json({ success: false, error: 'Race not found' }, { status: 404 })
  }

  // Per-wave fullness (mig 083; capacity numbers hidden from public).
  // Public callers only need to know whether each wave is bookable —
  // exposing exact "X of Y spots remaining" is operator-only data
  // (visible inside the CRM /races index). Strip raw capacity +
  // remaining numbers from the response shape; surface a boolean
  // is_full instead. One COUNT per wave is fine for v1 (waves per
  // race < ~10 in any realistic event).
  const wavesIn = (data.waves || []).slice().sort((a, b) =>
    (a.display_order ?? 0) - (b.display_order ?? 0) || (a.start_time || '').localeCompare(b.start_time || '')
  )
  const mode = data.capacity_mode === 'people' ? 'people' : 'teams'
  const publicWaves = []
  for (const w of wavesIn) {
    let isFull = false
    if (w.capacity != null) {
      if (mode === 'people') {
        // eslint-disable-next-line guardrails/no-uncapped-supabase-limit -- wave-capacity gate; a single race wave never holds >1000 registrations
        const { data: waveRegs } = await db
          .from('race_registrations')
          .select('status, team:teams ( size )')
          .eq('race_event_id', data.id)
          .eq('wave_id', w.id)
          .eq('status', 'confirmed')
          .limit(2000)
        isFull = loadForMode(waveRegs || [], 'people') >= w.capacity
      } else {
        const { count } = await db
          .from('race_registrations')
          .select('*', { count: 'exact', head: true })
          .eq('race_event_id', data.id)
          .eq('wave_id', w.id)
          .eq('status', 'confirmed')
        isFull = (count || 0) >= w.capacity
      }
    }
    // Strip capacity from the per-wave object — only id, start_time,
    // label, display_order, is_full leave the building.
    publicWaves.push({
      id: w.id,
      start_time: w.start_time,
      label: w.label,
      display_order: w.display_order,
      is_full: isFull,
    })
  }

  // Registration window state — saves the public form a round-trip.
  const now = Date.now()
  const opensAt = data.registration_opens_at ? Date.parse(data.registration_opens_at) : null
  const closesAt = data.registration_closes_at ? Date.parse(data.registration_closes_at) : null
  // Race is "full" when every wave with a cap is full AND there are
  // no uncapped waves to absorb. (An unlimited wave keeps the race
  // open even if every other wave is full.)
  const hasUncapped = wavesIn.some((w) => w.capacity == null)
  const allCappedFull = publicWaves.length > 0 && !hasUncapped && publicWaves.every((w) => w.is_full)
  let registration_state = 'open'
  if (opensAt && now < opensAt) registration_state = 'not_yet_open'
  else if (closesAt && now > closesAt) registration_state = 'closed'
  else if (allCappedFull) registration_state = 'full'

  // Strip the race-level deprecated capacity from the public response
  // too (defensive; the field is supposed to be deprecated but it
  // could still be on existing rows).
   
  const { capacity: _omit, host: _host, ...racePublic } = data

  // EVENT-COPY.1 — NEVER let the ops-only anchor label leave this endpoint.
  //
  // `RaceSignupWidget` renders `race.venue_name || location?.name`, which is the
  // exact `venue_name || location.name` pattern the comms modules just stopped
  // using — and the widget cannot judge the row, because it is a client
  // component and this response is all it sees. `ensureAnchorLocation` names a
  // host's anchor "<host> (host events)", so a staff-created host event with no
  // venue name would render that internal string as the venue on
  // /event/[slug] and /embed/event/[slug] — a public, higher-traffic surface
  // than any of the comms paths.
  //
  // Sanitising server-side rather than in the widget is deliberate: this is a
  // PUBLIC endpoint, so the internal label should not be in the payload at all,
  // never mind on the page. Resolve the venue here and blank the anchor's own
  // name/address so no present or future client can fall back onto them.
  const isAnchor = isHostAnchorLocation(racePublic.locations)
  const publicLocation = racePublic.locations
    ? (({ is_host_anchor: _flag, ...loc }) => (isAnchor ? { ...loc, name: null, address: null } : loc))(racePublic.locations)
    : racePublic.locations

  // HOST-CONSENT.1 — names for the two-consent copy on the register form.
  // organization_id is resolved here and stripped from the public payload.
  const { organization_id: _orgId, ...publicLocationSafe } = publicLocation || {}
  const organizationName = await getOrgBrandName(db, publicLocation?.organization_id || null)

  return NextResponse.json({
    success: true,
    data: {
      ...racePublic,
      locations: publicLocation ? publicLocationSafe : publicLocation,
      venue_name: pickAudienceVenueName({
        venueName: racePublic.venue_name,
        eventLocation: racePublic.locations,
      }) || null,
      waves: publicWaves,
      registration_state,
      host_name: data.host?.name || null,
      organization_name: organizationName,
    },
  })
}
