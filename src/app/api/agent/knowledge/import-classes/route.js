import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { MANAGER_ROLES } from '@/lib/schemas'
import { glofoxCredentialsForLocation, fetchUpcomingEvents } from '@/lib/glofox'
import { shapeClassKnowledgeFromEvents } from '@/lib/agent/knowledge-import'

// KNOWLEDGE-IMPORT.1 — POST: pull the next two weeks of the Glofox
// timetable and create one knowledge entry per class type, carrying
// the class description (member-facing copy from the Glofox booking
// app). Existing entries with the same title are NEVER overwritten —
// operator edits win; re-running only adds classes that are new.
// Entries with no Glofox description are created as disabled drafts
// (the prompt builder excludes empty content anyway) so the operator
// can fill them in.
export async function POST() {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!MANAGER_ROLES.includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
  const locationId = user.activeLocation?.id
  if (!locationId) return NextResponse.json({ success: false, error: 'No active location' }, { status: 400 })

  const db = createServerClient()
  const creds = await glofoxCredentialsForLocation(db, locationId)
  if (!creds?.branchId || !creds?.apiKey || !creds?.apiToken) {
    return NextResponse.json({ success: false, error: 'Glofox is not connected for this location.' }, { status: 400 })
  }

  const now = Math.floor(Date.now() / 1000)
  const res = await fetchUpcomingEvents(creds, { start: now, end: now + 14 * 86400, limit: 200 })
  if (!res.ok) {
    return NextResponse.json({ success: false, error: 'Could not load the Glofox timetable just now.' }, { status: 502 })
  }

  const candidates = shapeClassKnowledgeFromEvents(res.events)
  if (candidates.length === 0) {
    return NextResponse.json({ success: true, imported: [], skipped: [], message: 'No classes found on the next two weeks of the timetable.' })
  }

  // Never clobber operator-curated entries: match on lowercased title.
  const { data: existing } = await db.from('agent_knowledge')
    .select('title')
    .eq('location_id', locationId)
  const have = new Set((existing || []).map(r => String(r.title || '').trim().toLowerCase()))

  const fresh = candidates.filter(c => !have.has(c.title.toLowerCase()))
  const skipped = candidates.filter(c => have.has(c.title.toLowerCase())).map(c => c.title)

  let imported = []
  if (fresh.length > 0) {
    const { data, error } = await db.from('agent_knowledge')
      .insert(fresh.map(c => ({
        location_id: locationId,
        category: 'general',
        title: c.title,
        content: c.content,
        enabled: c.content.length > 0,
        sort_order: 0,
        updated_by: user.id,
      })))
      .select('id, category, title, content, enabled, sort_order, updated_at')
    if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
    imported = data || []
  }

  return NextResponse.json({
    success: true,
    imported,
    skipped,
    missing_description: fresh.filter(c => !c.content).map(c => c.title),
  })
}
