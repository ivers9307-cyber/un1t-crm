// HYROX-TC — POST /api/hyrox/sessions/[id]/push: manually put this session's
// board on the location's Hyrox TV(s) NOW — the same tv_content upsert the
// publish cron does at class time, but on demand. Only approved/published
// sessions can go on the wall. 404-not-403 detail-route posture.
import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { hasPermissionForLocation } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { APPROVAL_CATEGORY_PERMISSION } from '@shared/permissions'
import { resolveHyroxDisplayIds } from '@/lib/hyrox/publish'

export const dynamic = 'force-dynamic'

export async function POST(_request, { params }) {
  const { id } = await params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const db = createServerClient()
  const { data: session } = await db.from('hyrox_sessions')
    .select('id, location_id, status')
    .eq('id', id)
    .maybeSingle()
  if (!session) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  if (!hasPermissionForLocation(user, session.location_id, APPROVAL_CATEGORY_PERMISSION.hyrox_sessions)) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }
  if (!['approved', 'published'].includes(session.status)) {
    return NextResponse.json({ success: false, error: 'Approve the session before pushing it to the TV.' }, { status: 409 })
  }

  const { data: loc } = await db.from('locations').select('id, settings').eq('id', session.location_id).single()
  const { data: displays } = await db.from('tv_displays').select('id').eq('location_id', session.location_id).eq('active', true)
  const targetIds = resolveHyroxDisplayIds(loc, (displays || []).map((d) => d.id))
  if (!targetIds.length) return NextResponse.json({ success: false, error: 'No active TV to push to at this location.' }, { status: 409 })

  const nowIso = new Date().toISOString()
  const rows = targetIds.map((tvId) => ({
    tv_display_id: tvId,
    source_type: 'generated',
    source_ref: session.id,
    label: 'Hyrox Training Club',
    template_values: null,
    pushed_at: nowIso,
    pushed_by: user.id,
    // Manual marker (not the cron's 'cron:hyrox-publish'), so the cron won't
    // auto-revert it; a real class publish will still overwrite it at class time.
    triggered_by: `manual:${user.id}`,
  }))
  const { error } = await db.from('tv_content').upsert(rows, { onConflict: 'tv_display_id' })
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })

  return NextResponse.json({ success: true, data: { pushed: targetIds.length } })
}
