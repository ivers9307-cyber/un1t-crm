// GET loads the host's own event for the edit form; PUT applies edits and the
// price/date re-review transition. host_id === session.host.id or 404. (HOST-PORTAL.3)
// DELETE hard-deletes the host's own event, but ONLY when it is not published
// (unpublish first — closes the register-vs-delete race) AND has zero
// registrations — paid registrations mean money, and refunds are staff-only. (HOST-PORTAL.10)
import { NextResponse } from 'next/server'
import { getCurrentHost } from '@/lib/host-auth'
import { createServerClient } from '@/lib/supabase'
import { HostEventSchema, computeEditTransition } from '@/lib/host-events'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

async function loadOwn(db, session, id) {
  const { data } = await db
    .from('race_events')
    .select('id, host_id, status, kind, name, slug, description, race_date, registration_opens_at, registration_closes_at, allowed_team_sizes, non_member_fee_cents, hero_image_url, accent_hex, venue_name, venue_address, confirmation_email_subject, confirmation_email_intro, reminder_email_subject, reminder_email_intro, race_waves ( id, start_time, capacity, label, display_order )')
    .eq('id', id)
    .maybeSingle()
  if (!data || data.host_id !== session.host.id) return null
  return data
}

export async function GET(_request, props) {
  const params = await props.params
  const session = await getCurrentHost()
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  const db = createServerClient()
  const event = await loadOwn(db, session, params.id)
  if (!event) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  return NextResponse.json({ success: true, data: event })
}

export async function PUT(request, props) {
  const params = await props.params
  const session = await getCurrentHost()
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  let body
  try { body = await request.json() } catch { return NextResponse.json({ success: false, error: 'Invalid JSON' }, { status: 400 }) }
  const parsed = HostEventSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ success: false, error: 'Invalid event', issues: parsed.error.issues }, { status: 400 })
  const input = parsed.data

  const db = createServerClient()
  const current = await loadOwn(db, session, params.id)
  if (!current) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })

  const firstWave = (current.race_waves || [])[0] || null
  // Normalize to DB-column names so computeEditTransition compares like-for-like.
  const changes = {
    race_date: input.race_date,
    non_member_fee_cents: input.ticket_price_cents,
    waves: firstWave ? [{ id: firstWave.id, start_time: input.session_start_time }] : [],
  }
  const currentForDiff = {
    status: current.status,
    race_date: current.race_date,
    non_member_fee_cents: current.non_member_fee_cents,
    // race_waves.start_time is a Postgres TIME → PostgREST returns "HH:MM:SS";
    // input.session_start_time is "HH:MM". Slice to 5 so the wave-key compares
    // like-for-like — otherwise EVERY edit reads as a time change and a cosmetic
    // edit (e.g. a description typo) would knock a published event offline.
    waves: firstWave ? [{ id: firstWave.id, start_time: String(firstWave.start_time).slice(0, 5) }] : [],
  }
  const transition = computeEditTransition(currentForDiff, changes)

  const { error } = await db.from('race_events').update({
    kind: input.kind,
    name: input.name,
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
    status: transition.status,
    ...(transition.reReview ? { submitted_at: new Date().toISOString(), reviewed_at: null } : {}),
  }).eq('id', current.id)
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })

  const { error: waveErr } = firstWave
    ? await db.from('race_waves').update({ start_time: input.session_start_time, capacity: input.session_capacity, label: input.session_label ?? null }).eq('id', firstWave.id)
    : await db.from('race_waves').insert({ race_event_id: current.id, start_time: input.session_start_time, capacity: input.session_capacity, label: input.session_label ?? null, display_order: 0 })
  if (waveErr) return NextResponse.json({ success: false, error: waveErr.message }, { status: 500 })

  return NextResponse.json({ success: true, data: { id: current.id, status: transition.status, reReview: transition.reReview } })
}

export async function DELETE(_request, props) {
  const params = await props.params
  const session = await getCurrentHost()
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const db = createServerClient()
  const { data: race } = await db
    .from('race_events')
    .select('id, host_id, status, name')
    .eq('id', params.id)
    .maybeSingle()
  if (!race || race.host_id !== session.host.id) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }

  // Published events must come off sale BEFORE deletion. Public registration
  // only works on status='published', so a fresh registration could race in
  // between the zero-count check below and the delete — cascading away a
  // registration/payment row while the customer's Stripe checkout session
  // still exists (they'd pay for a deleted event). Non-published events can't
  // take new registrations, which makes the count check race-free.
  if (race.status === 'published') {
    return NextResponse.json(
      { success: false, error: 'Take the event off sale first, then delete it.' },
      { status: 409 }
    )
  }

  // ANY registration row (confirmed, pending, even cancelled) blocks the
  // delete — those rows carry payment history a host must not erase.
  // NOTE: head/count options are only read on the FIRST .select() after
  // .from(), and embedded-resource filters break under head:true — keep this
  // a bare count with plain .eq filters.
  const { count, error: countErr } = await db
    .from('race_registrations')
    .select('id', { count: 'exact', head: true })
    .eq('race_event_id', race.id)
  if (countErr) return NextResponse.json({ success: false, error: countErr.message }, { status: 500 })
  if ((count ?? 0) > 0) {
    return NextResponse.json(
      { success: false, error: 'This event has registrations — take it off sale instead; contact UN1T to cancel it fully.' },
      { status: 409 }
    )
  }

  // Zero registrations → hard delete. Children clean up via FK cascades:
  // race_waves (mig 083), race_registrations/race_payments (migs 082/084) and
  // promo_codes.event_id (mig 383) are all ON DELETE CASCADE.
  const { error: delErr } = await db.from('race_events').delete().eq('id', race.id)
  if (delErr) return NextResponse.json({ success: false, error: delErr.message }, { status: 500 })

  return NextResponse.json({ success: true })
}
