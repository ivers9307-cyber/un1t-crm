// GET /api/events/[id]/waitlist — EVENT-WAITLIST.1
//
// The event's waitlist for staff: every row (name, email, phone, size, joined,
// last offered, status) and how many are still waiting. Manager+ holding
// `races` at the event's studio; 404 for an event the caller cannot see.
// Staff data: the count and the list are never public.
import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { resolveStaffWaitlistEvent, listEventWaitlist } from '@/lib/event-waitlist-access'
import { logError } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(_request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  const ctx = await resolveStaffWaitlistEvent(user, params.id)
  if (ctx.response) return ctx.response

  const list = await listEventWaitlist(ctx.db, ctx.race)
  if (list.error) {
    logError('event-waitlist', 'staff list read failed', { err: list.error, eventId: ctx.race.id })
    return NextResponse.json({ success: false, error: 'load_failed', message: 'The waitlist could not be read. Try again.' }, { status: 500 })
  }
  return NextResponse.json({ success: true, data: { rows: list.rows, waiting: list.waiting } })
}
