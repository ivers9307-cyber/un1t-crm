// GET/PATCH /api/host/list-page — the host's own /h/[slug] page copy
// (HOST-GROWTH.7, mig 460). Host session; PATCH updates only the four copy
// columns for session.host.id (empty string → NULL → default copy on the
// public page). Partial updates: only supplied keys are written.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentHost } from '@/lib/host-auth'
import { createServerClient } from '@/lib/supabase'
import { logError } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const COLS = 'slug, list_headline, list_blurb, list_button_label, list_success_message'

const field = (max) => z.string().trim().max(max).optional()
const ListPageSchema = z.object({
  list_headline: field(120),
  list_blurb: field(500),
  list_button_label: field(40),
  list_success_message: field(500),
}).strict()

export async function GET() {
  const session = await getCurrentHost()
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  const db = createServerClient()
  const { data, error } = await db.from('event_hosts').select(COLS).eq('id', session.host.id).maybeSingle()
  if (error) {
    logError('host-list-page', 'load failed', { err: error })
    return NextResponse.json({ success: false, error: 'Could not load your signup page settings.' }, { status: 500 })
  }
  return NextResponse.json({ success: true, data: data || {} })
}

export async function PATCH(request) {
  const session = await getCurrentHost()
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  let body
  try { body = await request.json() } catch {
    return NextResponse.json({ success: false, error: 'Invalid JSON' }, { status: 400 })
  }
  const parsed = ListPageSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: 'Validation failed', issues: parsed.error.issues }, { status: 400 })
  }

  const patch = {}
  for (const [k, v] of Object.entries(parsed.data)) patch[k] = v === '' ? null : v
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ success: false, error: 'Nothing to update' }, { status: 400 })
  }

  const db = createServerClient()
  const { error } = await db.from('event_hosts').update(patch).eq('id', session.host.id)
  if (error) {
    logError('host-list-page', 'update failed', { err: error })
    return NextResponse.json({ success: false, error: 'Could not save — try again shortly.' }, { status: 500 })
  }
  return NextResponse.json({ success: true, data: patch })
}
