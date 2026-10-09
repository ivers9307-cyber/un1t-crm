// POST /api/host/events/[id]/waitlist/offer — EVENT-WAITLIST.1
//
// A host runs the offer round for one of their OWN events now (404
// otherwise). Same round and answer as the staff route
// (/api/events/[id]/waitlist/offer).
import { NextResponse } from 'next/server'
import { getCurrentHost } from '@/lib/host-auth'
import { resolveHostWaitlistEvent } from '@/lib/event-waitlist-access'
import { runWaitlistOffers } from '@/lib/event-waitlist'
import { logError } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 120

export async function POST(_request, props) {
  const params = await props.params
  const session = await getCurrentHost()
  const ctx = await resolveHostWaitlistEvent(session, params.id)
  if (ctx.response) return ctx.response
  try {
    const data = await runWaitlistOffers(ctx.db, { eventId: ctx.race.id })
    return NextResponse.json({ success: true, data })
  } catch (e) {
    logError('event-waitlist', 'host offer round failed', { err: e, eventId: ctx.race.id })
    return NextResponse.json({ success: false, error: 'load_failed', message: 'The waitlist could not be read. Try again.' }, { status: 500 })
  }
}
