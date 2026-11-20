// POST /api/host/events/[id]/waitlist/offer — EVENT-WAITLIST.1
//
// A host runs the offer round for one of their OWN events now (404
// otherwise), forced: everyone still on the list is offered again, ignoring
// the 24 h rule. Same round and answer as the staff route
// (/api/events/[id]/waitlist/offer).
//
// WAITLISTONE.1 — with a body `{ row_id }` it offers ONE person instead
// ("Offer space"): 409 when every time is full, the event is not bookable or
// they already booked; 404 for a row not on this event's list; 3 an hour per
// row.
import { NextResponse } from 'next/server'
import { getCurrentHost } from '@/lib/host-auth'
import { resolveHostWaitlistEvent, readOfferRowId, offerOneWaitlistRow } from '@/lib/event-waitlist-access'
import { runWaitlistOffers, offerWaitlistRow } from '@/lib/event-waitlist'
import { logError } from '@/lib/log'
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 120

export async function POST(request, props) {
  const params = await props.params
  const session = await getCurrentHost()
  const ctx = await resolveHostWaitlistEvent(session, params.id)
  if (ctx.response) return ctx.response
  // WAITLISTONE.1 — `{ row_id }`: offer a free place to that one person only.
  const one = await readOfferRowId(request)
  if (one.response) return one.response
  if (one.rowId) return offerOneWaitlistRow(ctx, one.rowId, { checkRateLimit, rateLimitResponse, offerWaitlistRow })
  // Each forced round emails everyone on the list again: 3 an hour per event,
  // shared by staff and the host (one key), checked after the gate.
  const limit = await checkRateLimit(ctx.db, `waitlist-offer:${ctx.race.id}`, { max: 3, windowMs: 3_600_000 })
  if (!limit.allowed) return rateLimitResponse(limit, 'Offer now can run 3 times an hour for an event. Try again later.')
  try {
    const data = await runWaitlistOffers(ctx.db, { eventId: ctx.race.id, force: true })
    return NextResponse.json({ success: true, data })
  } catch (e) {
    logError('event-waitlist', 'host offer round failed', { err: e, eventId: ctx.race.id })
    return NextResponse.json({ success: false, error: 'load_failed', message: 'The waitlist could not be read. Try again.' }, { status: 500 })
  }
}
