// POST /api/events/[id]/waitlist/offer — EVENT-WAITLIST.1
//
// Run the offer round for this event now instead of waiting for the next
// 10-minute tick, FORCED: if any time has room, everyone still on the list is
// offered again at once, whether or not they were offered in the last 24 h
// (the cron keeps the 24 h rule). Answers the round's counts; `no_room: 1`
// means every time is full and nobody was offered. Manager+ holding `races`
// at the event's studio.
import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { resolveStaffWaitlistEvent } from '@/lib/event-waitlist-access'
import { runWaitlistOffers } from '@/lib/event-waitlist'
import { logError } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 120

export async function POST(_request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  const ctx = await resolveStaffWaitlistEvent(user, params.id)
  if (ctx.response) return ctx.response
  try {
    const data = await runWaitlistOffers(ctx.db, { eventId: ctx.race.id, force: true })
    return NextResponse.json({ success: true, data })
  } catch (e) {
    logError('event-waitlist', 'staff offer round failed', { err: e, eventId: ctx.race.id })
    return NextResponse.json({ success: false, error: 'load_failed', message: 'The waitlist could not be read. Try again.' }, { status: 500 })
  }
}
