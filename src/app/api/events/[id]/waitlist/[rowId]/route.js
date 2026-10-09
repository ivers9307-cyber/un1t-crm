// DELETE /api/events/[id]/waitlist/[rowId] — EVENT-WAITLIST.1
//
// Take someone off an event's waitlist (status removed, who did it recorded).
// The row stays as history; if the person joins again it is reset to waiting.
// Manager+ holding `races` at the event's studio; 404 for a row that is not on
// this event (ids cannot be enumerated).
import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { uuidLike } from '@/lib/schemas'
import { resolveStaffWaitlistEvent, staffActorName } from '@/lib/event-waitlist-access'
import { logError } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function DELETE(_request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  const ctx = await resolveStaffWaitlistEvent(user, params.id)
  if (ctx.response) return ctx.response
  if (!uuidLike.safeParse(params.rowId).success) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }

  const { data, error } = await ctx.db
    .from('event_waitlist')
    .update({ status: 'removed', removed_by_name: staffActorName(user) })
    .eq('id', params.rowId)
    .eq('race_event_id', ctx.race.id)
    .eq('location_id', ctx.race.location_id)
    .select('id, status, removed_by_name')
  if (error) {
    logError('event-waitlist', 'remove failed', { err: error, eventId: ctx.race.id, rowId: params.rowId })
    return NextResponse.json({ success: false, error: 'write_failed', message: 'Could not remove them. Try again.' }, { status: 500 })
  }
  if (!data?.length) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  return NextResponse.json({ success: true, data: data[0] })
}
