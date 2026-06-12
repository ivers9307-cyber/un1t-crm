import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { MANAGER_ROLES } from '@/lib/schemas'
import { importClassKnowledge } from '@/lib/agent/knowledge-import'

// KNOWLEDGE-IMPORT.1 — POST: pull the Glofox timetable's class types +
// descriptions into knowledge for the active location. Existing titles
// are never overwritten; re-running only adds what's new. The weekly
// sync-class-knowledge cron runs the same core every Monday so the
// knowledge base keeps itself fresh.
export async function POST() {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!MANAGER_ROLES.includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
  const locationId = user.activeLocation?.id
  if (!locationId) return NextResponse.json({ success: false, error: 'No active location' }, { status: 400 })

  const db = createServerClient()
  const result = await importClassKnowledge(db, locationId, { updatedBy: user.id })
  if (!result.ok) {
    const msg = result.reason === 'glofox_not_connected'
      ? 'Glofox is not connected for this location.'
      : result.reason === 'glofox_unreachable'
        ? 'Could not load the Glofox timetable just now.'
        : result.reason
    return NextResponse.json({ success: false, error: msg }, { status: result.reason === 'glofox_not_connected' ? 400 : 502 })
  }

  return NextResponse.json({
    success: true,
    imported: result.imported,
    skipped: result.skipped,
    missing_description: result.missing_description,
  })
}
