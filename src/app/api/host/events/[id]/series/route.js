// /api/host/events/[id]/series — HOSTSERIES.1
//
// POST — make one of the host's OWN events the first date of a new series:
// a series row, the source stamped, one draft copy per other date. 404 for
// another host's event; 409 already_in_series; 400 invalid_dates; 500
// write_failed carries the copies made before the failure.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentHost } from '@/lib/host-auth'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { createSeriesFromEvent, SERIES_ERRORS, MAX_SERIES_DATES } from '@/lib/event-series'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const MakeSeriesBodySchema = z.object({
  name: z.string().trim().min(1).max(120),
  dates: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).min(1).max(MAX_SERIES_DATES),
}).strict()

const STATUS_FOR = Object.freeze({
  [SERIES_ERRORS.NOT_FOUND]: 404,
  [SERIES_ERRORS.ALREADY_IN_SERIES]: 409,
  [SERIES_ERRORS.INVALID_DATES]: 400,
})

export async function POST(request, props) {
  const params = await props.params
  const session = await getCurrentHost()
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const db = createServerClient()
  const { data: race } = await db.from('race_events').select('id, host_id').eq('id', params.id).maybeSingle()
  if (!race || race.host_id !== session.host.id) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })

  const validation = await validateBody(request, MakeSeriesBodySchema)
  if (!validation.ok) return validation.response

  const result = await createSeriesFromEvent(db, { sourceId: race.id, dates: validation.data.dates, name: validation.data.name })
  if (!result.ok) {
    return NextResponse.json(
      { success: false, error: result.error, message: result.message, ...(result.created ? { created: result.created } : {}) },
      { status: STATUS_FOR[result.error] || 500 },
    )
  }
  return NextResponse.json({ success: true, data: { series: result.series, created: result.created } })
}
