// GET /api/un1t-online/classes?location_id=&contact_id= — UN1TWRITE.14.
//
// The staff Book panel's class list at a un1t.online studio: scheduled
// classes in the next 14 days from the synced timetable (un1t_events), with
// spots left (staff only; this route is never public, PUBCAP.1 is the
// customer rule), community classes labelled, the person's credits from the
// mirror and their upcoming bookings there. Gated by gateUn1tStaffBooking:
// access at the BOOKING studio, writes on, the contact in its organisation
// with a un1t.online account there.
// UN1TCOMP.1 — also the Hatch card's complimentary credits block: whether
// this member of staff may add them here (un1t_comp_credits at the studio),
// the grants already given to this person at this studio (done, and in doubt
// marked unconfirmed), and the studio's zone, so the card's use-by maths runs
// on the studio's clock.

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { uuidLike } from '@/lib/schemas'
import { gateUn1tStaffBooking } from '@/lib/un1t-staff-booking'
import { getLocationZone, formatInZone, DEFAULT_TZ } from '@/lib/location-time'
import { logWarn } from '@/lib/log'
import { freshCutoff, onlyFreshEvents } from '@/lib/un1t-online-freshness'
import { canGrantCompCredits } from '@/lib/un1t-comp-credits-access'
import { compReasonLabel } from '@/lib/un1t-comp-credits'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const WINDOW_DAYS = 14
const LIMIT = 200
const DAY_OPTS = Object.freeze({ weekday: 'short', day: 'numeric', month: 'short' })
const TIME_OPTS = Object.freeze({ hour: '2-digit', minute: '2-digit', hour12: false })
// The card's "Complimentary credits given" list: the newest few are plenty.
const COMP_GIVEN_LIMIT = 50

const firstName = (full) => (typeof full === 'string' && full.trim() ? full.trim().split(/\s+/)[0] : null)

/**
 * UN1TCOMP.1 — this person's complimentary grants at this studio from the
 * write ledger (done, and unknown as unconfirmed; a refused one gave
 * nothing), with the first name of who gave each. A failed read is logged
 * and the list is left out (null), never shown as "none given".
 */
async function compGiven(db, { locationId, un1tUserId }) {
  const { data: rows, error } = await db
    .from('un1t_write_events')
    .select('id, stage, created_at, actor_user_id, comp_amount, comp_reason, comp_use_by, comp_expires_at')
    .eq('location_id', locationId)
    .eq('op', 'comp_credits')
    .eq('un1t_user_id', un1tUserId)
    .in('stage', ['done', 'unknown'])
    .order('created_at', { ascending: false })
    .limit(COMP_GIVEN_LIMIT)
  if (error) {
    logWarn('un1t-staff-classes', 'complimentary credits read failed', { locationId, err: error })
    return null
  }
  const actorIds = [...new Set((rows || []).map((r) => r.actor_user_id).filter(Boolean))]
  let names = new Map()
  if (actorIds.length > 0) {
    // By id: a tombstoned profile keeps its full_name (mig 622), so history still names them.
    const { data: people, error: pErr } = await db.from('profiles').select('id, full_name').in('id', actorIds)
    if (pErr) logWarn('un1t-staff-classes', 'complimentary credits staff names read failed', { locationId, err: pErr })
    names = new Map((people || []).map((p) => [p.id, firstName(p.full_name)]))
  }
  return (rows || []).map((r) => ({
    id: r.id,
    at: r.created_at,
    amount: r.comp_amount,
    reason: compReasonLabel(r.comp_reason),
    use_by: r.comp_use_by,
    expires_at: r.comp_expires_at ?? null,
    by: names.get(r.actor_user_id) ?? null,
    confirmed: r.stage === 'done',
  }))
}

export async function GET(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  const url = new URL(request.url)
  const locationId = url.searchParams.get('location_id')
  const contactId = url.searchParams.get('contact_id')
  if (!uuidLike.safeParse(locationId).success || !uuidLike.safeParse(contactId).success) {
    return NextResponse.json({ success: false, error: 'Provide ?location_id=<uuid>&contact_id=<uuid>' }, { status: 400 })
  }

  const db = createServerClient()
  const gate = await gateUn1tStaffBooking(db, user, { locationId, contactId })
  if (!gate.ok) return NextResponse.json({ success: false, error: gate.error }, { status: gate.status })

  const now = Date.now()
  // UN1TBOOK.19 — only classes the latest sync saw: the mirror never deletes,
  // so a class deleted upstream stays 'scheduled' and its booking 404s. A
  // stalled sync keeps every row (freshCutoff is relative to the newest run).
  let cutoffIso
  try {
    cutoffIso = await freshCutoff(db, 'un1t_events', locationId)
  } catch (err) {
    logWarn('un1t-staff-classes', 'timetable freshness unreadable', { locationId, err })
    return NextResponse.json({ success: false, error: 'Could not read the timetable just now. Try again.' }, { status: 503 })
  }
  const { data: events, error: evErr } = await onlyFreshEvents(db
    .from('un1t_events')
    .select('un1t_id, title, starts_at, capacity, bookings_count, access_mode')
    .eq('location_id', locationId)
    .eq('status', 'scheduled')
    .gt('starts_at', new Date(now).toISOString())
    .lte('starts_at', new Date(now + WINDOW_DAYS * 86_400_000).toISOString()), cutoffIso)
    .order('starts_at', { ascending: true })
    .limit(LIMIT)
  if (evErr) return NextResponse.json({ success: false, error: 'Could not read the timetable just now. Try again.' }, { status: 503 })

  const zone = await getLocationZone(db, locationId).catch((err) => {
    logWarn('un1t-staff-classes', 'location zone unreadable; labelling in the default zone', { locationId, err })
    return DEFAULT_TZ
  })
  const classes = (events || []).filter((e) => e?.un1t_id && Number.isFinite(Date.parse(e.starts_at))).map((e) => {
    const d = new Date(e.starts_at)
    const capacity = Number.isFinite(e.capacity) && e.capacity > 0 ? e.capacity : null
    return {
      id: String(e.un1t_id),
      name: typeof e.title === 'string' ? e.title.trim() : 'Class',
      starts_at: d.toISOString(),
      day: formatInZone(d, zone, DAY_OPTS, 'en-IE'),
      time: formatInZone(d, zone, TIME_OPTS, 'en-GB'),
      spots_left: capacity == null ? null : Math.max(0, capacity - (Number(e.bookings_count) || 0)),
      community: e.access_mode === 'community',
    }
  })

  const { data: client, error: clientErr } = await db
    .from('un1t_clients')
    .select('credit_balance, credit_unlimited, crm_written_at, synced_at')
    .eq('location_id', locationId)
    .eq('un1t_user_id', gate.un1tUserId)
    .limit(1)
    .maybeSingle()
  if (clientErr) logWarn('un1t-staff-classes', 'credits read failed', { locationId, err: clientErr })
  const credits = {
    balance: Number.isFinite(client?.credit_balance) ? client.credit_balance : null,
    unlimited: client?.credit_unlimited === true,
    as_of: client?.crm_written_at ?? client?.synced_at ?? null,
  }

  const { data: bookings, error: bkErr } = await db
    .from('un1t_bookings')
    .select('un1t_id, event_id, status')
    .eq('location_id', locationId)
    .eq('un1t_user_id', gate.un1tUserId)
    .eq('status', 'booked')
    .order('remote_created_at', { ascending: false })
    .limit(LIMIT)
  if (bkErr) logWarn('un1t-staff-classes', 'upcoming bookings read failed', { locationId, err: bkErr })
  const eventIds = [...new Set((bookings || []).map((b) => b.event_id).filter(Boolean).map(String))]
  let upcoming = []
  if (eventIds.length > 0) {
    const { data: theirEvents, error: teErr } = await db
      .from('un1t_events')
      .select('un1t_id, title, starts_at')
      .eq('location_id', locationId)
      .in('un1t_id', eventIds)
      .eq('status', 'scheduled')
      .gt('starts_at', new Date(now).toISOString())
    if (teErr) logWarn('un1t-staff-classes', 'upcoming events read failed', { locationId, err: teErr })
    const byId = new Map((theirEvents || []).map((e) => [String(e.un1t_id), e]))
    upcoming = (bookings || [])
      .filter((b) => byId.has(String(b.event_id)))
      .map((b) => {
        const e = byId.get(String(b.event_id))
        return { booking_id: String(b.un1t_id), event_id: String(b.event_id), name: typeof e.title === 'string' ? e.title.trim() : 'Class', starts_at: e.starts_at }
      })
      .sort((a, b) => String(a.starts_at).localeCompare(String(b.starts_at)))
  }

  const comp = {
    can_grant: canGrantCompCredits(user, locationId),
    given: await compGiven(db, { locationId, un1tUserId: gate.un1tUserId }),
  }

  return NextResponse.json({ success: true, data: { classes, credits, upcoming, spots_note: 'as of last sync', zone, comp } })
}
