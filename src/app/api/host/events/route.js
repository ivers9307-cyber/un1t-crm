// GET /api/host/events — the host's OWN events. The `.eq('host_id', host.id)`
// filter is the entire tenancy boundary of the portal: a host can only ever see
// events assigned to them. (HOST-PORTAL.1)
//
// POST /api/host/events — create a new event as a draft (host-scoped). The
// event hangs off the host's hidden anchor location and is forced through
// hostEventDefaults() so a host can never touch UN1T-only levers. (HOST-PORTAL.3)

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { logError } from '@/lib/log'
import { getCurrentHost } from '@/lib/host-auth'
import { HostEventSchema, hostEventDefaults, ensureAnchorLocation } from '@/lib/host-events'
import { eventSlug, uniqueEventSlug } from '@/lib/event-slug'
import { syncEventSessions } from '@/lib/event-sessions'
import { hostOwnsSeries } from '@/lib/event-series'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const session = await getCurrentHost()
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const db = createServerClient()
  const { data, error } = await db
    .from('race_events')
    .select('id, name, slug, race_date, kind, active')
    .eq('host_id', session.host.id)
    .order('race_date', { ascending: false })
    .limit(200)
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  return NextResponse.json({ success: true, data: data || [] })
}

export async function POST(request) {
  const session = await getCurrentHost()
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  let body
  try { body = await request.json() } catch { return NextResponse.json({ success: false, error: 'Invalid JSON' }, { status: 400 }) }
  const parsed = HostEventSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ success: false, error: 'Invalid event', issues: parsed.error.issues }, { status: 400 })
  const input = parsed.data

  const db = createServerClient()
  // HOSTSERIES.1 — a series id from the body must be this host's own.
  if (input.series_id) {
    const owns = await hostOwnsSeries(db, { seriesId: input.series_id, hostId: session.host.id })
    if (!owns.ok) {
      return owns.error === 'load_failed'
        ? NextResponse.json({ success: false, error: 'load_failed', message: 'The series could not be read. Try again.' }, { status: 500 })
        : NextResponse.json({ success: false, error: 'invalid_series', message: 'That series is not one of yours.' }, { status: 400 })
    }
  }
  const { data: host } = await db
    .from('event_hosts')
    .select('id, name, organization_id, anchor_location_id')
    .eq('id', session.host.id)
    .single()
  if (!host) return NextResponse.json({ success: false, error: 'Host not found' }, { status: 404 })

  const locationId = await ensureAnchorLocation(db, host)

  // EVENT-SLUG.1 — /event/hatch-oct18-1100: venue + date + session time.
  // Globally unique (mig 451: /event/[slug] resolves with no location
  // filter, so the probe is global too — HOST-APPROVALS.1); a
  // same-place-same-time clash takes -2, -3…
  // HOSTSERIES.1 — the FIRST session's time names the slug.
  const slug = await uniqueEventSlug(db, eventSlug({
    place: input.venue_name,
    date: input.race_date,
    time: input.sessions[0].start_time,
    name: input.name,
  }))

  const defaults = hostEventDefaults()
  const { data: event, error } = await db
    .from('race_events')
    .insert({
      location_id: locationId,
      host_id: host.id,
      status: 'draft',
      active: true,
      kind: input.kind,
      name: input.name,
      slug,
      description: input.description ?? null,
      race_date: input.race_date,
      registration_opens_at: input.registration_opens_at ?? null,
      registration_closes_at: input.registration_closes_at ?? null,
      allowed_team_sizes: input.allowed_team_sizes,
      non_member_fee_cents: input.ticket_price_cents,
      hero_image_url: input.hero_image_url ?? null,
      accent_hex: input.accent_hex ?? null,
      venue_name: input.venue_name,
      venue_address: input.venue_address ?? null,
      confirmation_email_subject: input.confirmation_email_subject ?? null,
      confirmation_email_intro: input.confirmation_email_intro ?? null,
      reminder_email_subject: input.reminder_email_subject ?? null,
      reminder_email_intro: input.reminder_email_intro ?? null,
      series_id: input.series_id ?? null,
      pricing_tiers: input.pricing_tiers ?? null,
      registration_questions: input.registration_questions ?? null,
      ...defaults,
    })
    .select('id, slug')
    .single()
  if (error || !event) return NextResponse.json({ success: false, error: error?.message || 'Create failed' }, { status: 500 })

  // HOSTSERIES.1 — every session is a race_waves row, written by the one
  // helper the edit route uses too. A refusal (two sessions at one time) or a
  // failed write leaves no half-made event behind.
  const synced = await syncEventSessions(db, { eventId: event.id, sessions: input.sessions, currentWaves: [] })
  if (!synced.ok) {
    const { error: delErr } = await db.from('race_events').delete().eq('id', event.id)
    if (delErr) logError('host-events', 'rollback of a sessionless event failed', { err: delErr, eventId: event.id })
    const status = synced.error === 'write_failed' ? 500 : 409
    return NextResponse.json({ success: false, error: synced.message, code: synced.error }, { status })
  }

  return NextResponse.json({ success: true, data: { id: event.id } })
}
