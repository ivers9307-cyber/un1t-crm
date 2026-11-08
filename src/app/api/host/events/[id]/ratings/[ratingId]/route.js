// /api/host/events/[id]/ratings/[ratingId] — HOSTPAGE.2
//
// PATCH { is_public } — a host hides or shows ONE rating of their own event.
// The update is pinned to the event (eq id + eq race_event_id) and judged by
// the rows it touched: a rating on another event is 404, never a silent
// no-op.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentHost } from '@/lib/host-auth'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'
import { logWarn } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const RatingVisibilitySchema = z.object({ is_public: z.boolean() }).strict()

const notFound = () => NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })

export async function PATCH(request, props) {
  const params = await props.params
  const session = await getCurrentHost()
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!uuidLike.safeParse(params.ratingId).success) return notFound()

  const db = createServerClient()
  const { data: race } = await db.from('race_events').select('id, host_id').eq('id', params.id).maybeSingle()
  if (!race || race.host_id !== session.host.id) return notFound()

  const validation = await validateBody(request, RatingVisibilitySchema)
  if (!validation.ok) return validation.response

  const { data, error } = await db
    .from('event_ratings')
    .update({ is_public: validation.data.is_public })
    .eq('id', params.ratingId)
    .eq('race_event_id', race.id)
    .select('id')
  if (error) {
    logWarn('host-event-ratings', 'visibility write failed', { err: error, ratingId: params.ratingId })
    return NextResponse.json({ success: false, error: 'Could not update the rating — try again.' }, { status: 500 })
  }
  if (!Array.isArray(data) || data.length === 0) return notFound()
  return NextResponse.json({ success: true, data: { id: params.ratingId, is_public: validation.data.is_public } })
}
