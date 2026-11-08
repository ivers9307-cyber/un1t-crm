// /api/host/series/[id] — HOSTSERIES.1
//
// PATCH — the host edits a series' name and its public page copy (headline,
// blurb; empty = back to the default). Own series or 404.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentHost } from '@/lib/host-auth'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const nullable = (max) => z.string().trim().max(max).nullable().optional().transform((v) => (v == null || v === '' ? null : v))

export const SeriesPatchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  headline: nullable(120),
  blurb: nullable(500),
}).strict()

export async function PATCH(request, props) {
  const params = await props.params
  const session = await getCurrentHost()
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const db = createServerClient()
  const { data: series } = await db.from('event_series').select('id, host_id').eq('id', params.id).maybeSingle()
  if (!series || series.host_id !== session.host.id) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })

  const validation = await validateBody(request, SeriesPatchSchema)
  if (!validation.ok) return validation.response
  const patch = {}
  for (const key of ['name', 'headline', 'blurb']) {
    if (key in validation.data && validation.data[key] !== undefined) patch[key] = validation.data[key]
  }
  if (Object.keys(patch).length === 0) return NextResponse.json({ success: true, data: { unchanged: true } })

  const { error } = await db.from('event_series').update(patch).eq('id', series.id)
  if (error) return NextResponse.json({ success: false, error: 'write_failed', message: 'The series could not be saved. Try again.' }, { status: 500 })
  return NextResponse.json({ success: true, data: { id: series.id, ...patch } })
}
