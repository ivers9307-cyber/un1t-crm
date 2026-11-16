// STALEWATCH.1 — acknowledge a known stale job (master only).
//
//   POST   { hours: 1..720, note?: string }  quiet until now + hours
//   DELETE                                    clear the acknowledgement
//
// While acknowledged, the job neither alerts (stale-job watchdog) nor holds
// /api/cron/health-check red; the acknowledgement runs out on its own, so a
// fault nobody fixes comes back rather than being muted for ever.
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const Body = z.object({
  hours: z.number().int().min(1).max(720),
  note: z.string().trim().max(500).optional().nullable(),
})

async function master() {
  const user = await getCurrentUser()
  return user && user.profileRole === 'master' ? user : null
}

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,79}$/

export async function POST(request, { params }) {
  const user = await master()
  if (!user) return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  const { name } = await params
  if (!NAME_RE.test(String(name || ''))) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  const validation = await validateBody(request, Body)
  if (!validation.ok) return validation.response
  const until = new Date(Date.now() + validation.data.hours * 3_600_000).toISOString()
  const { data, error } = await createServerClient()
    .from('cron_heartbeats')
    .update({ acknowledged_until: until, acknowledged_by: user.id, acknowledged_note: validation.data.note || null })
    .eq('name', name)
    .select('name, acknowledged_until, acknowledged_note')
  if (error) return NextResponse.json({ success: false, error: 'Could not acknowledge the job.' }, { status: 500 })
  if (!data?.length) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  return NextResponse.json({ success: true, data: data[0] })
}

export async function DELETE(_request, { params }) {
  const user = await master()
  if (!user) return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  const { name } = await params
  if (!NAME_RE.test(String(name || ''))) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  const { data, error } = await createServerClient()
    .from('cron_heartbeats')
    .update({ acknowledged_until: null, acknowledged_by: null, acknowledged_note: null })
    .eq('name', name)
    .select('name')
  if (error) return NextResponse.json({ success: false, error: 'Could not clear the acknowledgement.' }, { status: 500 })
  if (!data?.length) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  return NextResponse.json({ success: true, data: data[0] })
}
