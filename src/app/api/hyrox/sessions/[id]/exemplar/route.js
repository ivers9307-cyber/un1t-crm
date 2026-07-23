// HYROX-STYLE — POST /api/hyrox/sessions/[id]/exemplar: "star as style example".
// Renders the session server-side (sessionToExampleText) and appends it to
// locations.settings.hyrox.style_examples (dedupe by session id, capped).
// Detail-route IDOR posture: a missing session or missing per-location
// permission both answer 404 (not 403) — same as the sibling session routes.
import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { hasPermissionForLocation } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { APPROVAL_CATEGORY_PERMISSION } from '@shared/permissions'
import { sessionToExampleText } from '@/lib/hyrox/example-text'
import { MAX_STORED_EXAMPLES } from '@/lib/hyrox/constants'

export const dynamic = 'force-dynamic'

export async function POST(request, { params }) {
  const { id } = await params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  const db = createServerClient()
  const { data: session } = await db.from('hyrox_sessions').select('*').eq('id', id).maybeSingle()
  if (!session) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  if (!hasPermissionForLocation(user, session.location_id, APPROVAL_CATEGORY_PERMISSION.hyrox_sessions)) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }
  const { data: loc } = await db.from('locations').select('id, name, settings').eq('id', session.location_id).single()
  const settings = { ...(loc?.settings || {}) }
  const hyrox = { ...(settings.hyrox || {}) }
  const existing = Array.isArray(hyrox.style_examples) ? hyrox.style_examples : []
  const exampleId = `session:${session.id}`
  if (existing.some((e) => e?.id === exampleId)) {
    return NextResponse.json({ success: true, data: { added: false, reason: 'already_saved' } })
  }
  const entry = { id: exampleId, source: 'generated', label: `Week ${session.week_no} session ${session.slot}${session.focus ? ` — ${session.focus}` : ''}`, text: sessionToExampleText(session), added_at: new Date().toISOString() }
  hyrox.style_examples = [entry, ...existing].slice(0, MAX_STORED_EXAMPLES)
  settings.hyrox = hyrox
  const { error } = await db.from('locations').update({ settings }).eq('id', session.location_id).select('id').single()
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  return NextResponse.json({ success: true, data: { added: true } })
}
