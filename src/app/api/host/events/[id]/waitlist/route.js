// GET /api/host/events/[id]/waitlist — EVENT-WAITLIST.1
//
// A host's view of the waitlist of one of their OWN events (404 otherwise):
// every row and how many are still waiting. Read-only: removing someone is a
// staff action. Host data: never public.
import { NextResponse } from 'next/server'
import { getCurrentHost } from '@/lib/host-auth'
import { resolveHostWaitlistEvent, listEventWaitlist } from '@/lib/event-waitlist-access'
import { logError } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(_request, props) {
  const params = await props.params
  const session = await getCurrentHost()
  const ctx = await resolveHostWaitlistEvent(session, params.id)
  if (ctx.response) return ctx.response

  const list = await listEventWaitlist(ctx.db, ctx.race)
  if (list.error) {
    logError('event-waitlist', 'host list read failed', { err: list.error, eventId: ctx.race.id })
    return NextResponse.json({ success: false, error: 'load_failed', message: 'The waitlist could not be read. Try again.' }, { status: 500 })
  }
  return NextResponse.json({ success: true, data: { rows: list.rows, waiting: list.waiting } })
}
