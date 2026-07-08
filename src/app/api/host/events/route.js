// GET /api/host/events — the host's OWN events. The `.eq('host_id', host.id)`
// filter is the entire tenancy boundary of the portal: a host can only ever see
// events assigned to them. (HOST-PORTAL.1)
//
// POST /api/host/events — create a new event as a draft (host-scoped). The
// event hangs off the host's hidden anchor location and is forced through
// hostEventDefaults() so a host can never touch UN1T-only levers. (HOST-PORTAL.3)

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentHost } from '@/lib/host-auth'
import { HostEventSchema, hostEventDefaults, deriveSlug, ensureAnchorLocation } from '@/lib/host-events'

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
  const { data: host } = await db
    .from('event_hosts')
    .select('id, name, organization_id, anchor_location_id')
    .eq('id', session.host.id)
    .single()
  if (!host) return NextResponse.json({ success: false, error: 'Host not found' }, { status: 404 })

  const locationId = await ensureAnchorLocation(db, host)

  let slug = deriveSlug(input.name)
  for (let n = 2; ; n++) {
    const { data: clash } = await db.from('race_events').select('id').eq('location_id', locationId).eq('slug', slug).maybeSingle()
    if (!clash) break
    slug = `${deriveSlug(input.name)}-${n}`
  }

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
      ...defaults,
    })
    .select('id, slug')
    .single()
  if (error || !event) return NextResponse.json({ success: false, error: error?.message || 'Create failed' }, { status: 500 })

  const { error: waveErr } = await db.from('race_waves').insert({
    race_event_id: event.id,
    start_time: input.session_start_time,
    capacity: input.session_capacity,
    label: input.session_label ?? null,
    display_order: 0,
  })
  if (waveErr) {
    await db.from('race_events').delete().eq('id', event.id)
    return NextResponse.json({ success: false, error: waveErr.message }, { status: 500 })
  }

  return NextResponse.json({ success: true, data: { id: event.id } })
}
