// GET loads the host's own event for the edit form; PUT applies edits and the
// price/date re-review transition. host_id === session.host.id or 404. (HOST-PORTAL.3)
// DELETE hard-deletes the host's own event, but ONLY when it is not published
// (unpublish first — closes the register-vs-delete race) AND has zero
// registrations — paid registrations mean money, and refunds are staff-only. (HOST-PORTAL.10)
import { NextResponse } from 'next/server'
import { getCurrentHost } from '@/lib/host-auth'
import { createServerClient } from '@/lib/supabase'
import { HostEventSchema, computeEditTransition } from '@/lib/host-events'
import { eventSlug, uniqueEventSlug, shouldRederiveSlug } from '@/lib/event-slug'
import { resolveHostOrgBrand } from '@/lib/host-org-brand'
import { syncEventSessions, judgeSessions, sessionsFromWaves } from '@/lib/event-sessions'
import { hostOwnsSeries } from '@/lib/event-series'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

async function loadOwn(db, session, id) {
  const { data } = await db
    .from('race_events')
    .select('id, host_id, status, kind, name, slug, description, race_date, registration_opens_at, registration_closes_at, allowed_team_sizes, non_member_fee_cents, hero_image_url, accent_hex, venue_name, venue_address, confirmation_email_subject, confirmation_email_intro, reminder_email_subject, reminder_email_intro, series_id, pricing_tiers, registration_questions, race_waves ( id, start_time, capacity, label, display_order )')
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
  // HOSTSERIES.1 — the form reads sessions (HH:MM), not raw waves.
  const { race_waves: waves, ...rest } = event
  return NextResponse.json({ success: true, data: { ...rest, sessions: sessionsFromWaves(waves) } })
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
  // HOSTSERIES.1 — a series id from the body must be this host's own.
  if (input.series_id) {
    const owns = await hostOwnsSeries(db, { seriesId: input.series_id, hostId: session.host.id })
    if (!owns.ok) {
      return owns.error === 'load_failed'
        ? NextResponse.json({ success: false, error: 'load_failed', message: 'The series could not be read. Try again.' }, { status: 500 })
        : NextResponse.json({ success: false, error: 'invalid_series', message: 'That series is not one of yours.' }, { status: 400 })
    }
  }

  // HOSTSERIES.1 — normalise to DB-column names so computeEditTransition
  // compares like-for-like: existing sessions by id (HH:MM on both sides;
  // race_waves.start_time is a Postgres TIME, "HH:MM:SS" from PostgREST), a
  // new session has no id and never re-reviews.
  const changes = {
    race_date: input.race_date,
    non_member_fee_cents: input.ticket_price_cents,
    pricing_tiers: input.pricing_tiers ?? null,
    waves: input.sessions.filter((s) => s.id).map((s) => ({ id: s.id, start_time: s.start_time })),
  }
  const currentForDiff = {
    status: current.status,
    race_date: current.race_date,
    non_member_fee_cents: current.non_member_fee_cents,
    pricing_tiers: current.pricing_tiers ?? null,
    waves: sessionsFromWaves(current.race_waves).map((s) => ({ id: s.id, start_time: s.start_time })),
  }
  const transition = computeEditTransition(currentForDiff, changes)

  // HOSTSERIES.1 — judge the session change BEFORE the event row is written:
  // a refused swap or removal must not leave a published event stamped back
  // to review with its times unchanged.
  const judged = await judgeSessions(db, { eventId: current.id, sessions: input.sessions, currentWaves: current.race_waves || [] })
  if (!judged.ok) {
    const status = judged.error === 'write_failed' ? 500 : 409
    return NextResponse.json({ success: false, error: judged.error, message: judged.message, session_time: judged.session_time ?? null }, { status })
  }

  // EVENT-SLUG.1 — a draft's URL follows its venue/date/time; once
  // published the slug is frozen (the link may be out).
  const slugPatch = shouldRederiveSlug(current.status)
    ? { slug: await uniqueEventSlug(db, eventSlug({ place: input.venue_name, date: input.race_date, time: input.sessions[0].start_time, name: input.name }), { excludeId: current.id }) }
    : {}

  const { error } = await db.from('race_events').update({
    ...slugPatch,
    kind: input.kind,
    name: input.name,
    description: input.description ?? null,
    race_date: input.race_date,
    registration_opens_at: input.registration_opens_at ?? null,
    registration_closes_at: input.registration_closes_at ?? null,
    allowed_team_sizes: input.allowed_team_sizes,
    non_member_fee_cents: input.ticket_price_cents,
    pricing_tiers: input.pricing_tiers ?? null,
    registration_questions: input.registration_questions ?? null,
    hero_image_url: input.hero_image_url ?? null,
    accent_hex: input.accent_hex ?? null,
    venue_name: input.venue_name,
    venue_address: input.venue_address ?? null,
    confirmation_email_subject: input.confirmation_email_subject ?? null,
    confirmation_email_intro: input.confirmation_email_intro ?? null,
    reminder_email_subject: input.reminder_email_subject ?? null,
    reminder_email_intro: input.reminder_email_intro ?? null,
    ...('series_id' in input ? { series_id: input.series_id ?? null } : {}),
    status: transition.status,
    ...(transition.reReview ? { submitted_at: new Date().toISOString(), reviewed_at: null } : {}),
  }).eq('id', current.id)
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })

  // HOSTSERIES.1 — the writes (judged above; a write that still fails is 500).
  const synced = await syncEventSessions(db, { eventId: current.id, sessions: input.sessions, currentWaves: current.race_waves || [] })
  if (!synced.ok) {
    const status = synced.error === 'write_failed' ? 500 : 409
    return NextResponse.json({ success: false, error: synced.error, message: synced.message, session_time: synced.session_time ?? null }, { status })
  }

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
    // W1.S1c: the host's organisation is who cancels an event fully.
    const brand = await resolveHostOrgBrand(db, session.host)
    return NextResponse.json(
      { success: false, error: `This event has registrations. Take it off sale instead, and contact ${brand.name} to cancel it fully.` },
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
