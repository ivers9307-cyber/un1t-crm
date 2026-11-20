// GET /api/events/[id]/waitlist — EVENT-WAITLIST.1
//
// The event's waitlist for staff: every row (name, email, phone, size, joined,
// last offered, status) and how many are still waiting. Manager+ holding
// `races` at the event's studio; 404 for an event the caller cannot see.
// Staff data: the count and the list are never public.
import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { resolveStaffWaitlistEvent, listEventWaitlist } from '@/lib/event-waitlist-access'
import { logError } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// The gate is judged at the EVENT's studio, so withAuth only signs the caller
// in; resolveStaffWaitlistEvent keeps the races-somewhere 403, the 404 and the
// races + manager-at-the-event's-studio 403, shared with the sibling routes.
export const GET = withAuth({ permission: null, location: false }, async ({ user, params }) => {
  const ctx = await resolveStaffWaitlistEvent(user, params?.id)
  if (ctx.response) return ctx.response

  const list = await listEventWaitlist(ctx.db, ctx.race)
  if (list.error) {
    logError('event-waitlist', 'staff list read failed', { err: list.error, eventId: ctx.race.id })
    return NextResponse.json({ success: false, error: 'load_failed', message: 'The waitlist could not be read. Try again.' }, { status: 500 })
  }
  return NextResponse.json({ success: true, data: { rows: list.rows, waiting: list.waiting } })
})
