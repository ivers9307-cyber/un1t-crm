// GET /api/whatsapp/unread-count
//
// SIDEBAR-BADGES.1 — sidebar badge count for the Communications hub.
// UIX-P1b made the inbox a unified WhatsApp + Instagram queue, so the
// count now sums unread across BOTH channels' conversations at the
// active location (route name kept — both pollers point here).
// Follows the { success, data: { count } } envelope the Sidebar's
// usePolledCount expects; returns 0 for users without the whatsapp
// permission (or no active location).
//
// Not paginated, by design — this mirrors the established dashboard query
// (one gym location never has >1000 conversations sitting unread); the
// badge caps its display at 99+ regardless.

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const user = await getCurrentUser()
  if (!user || !hasPermission(user, 'whatsapp')) {
    return NextResponse.json({ success: true, data: { count: 0 } })
  }
  const locationId = user.activeLocation?.id
  if (!locationId) {
    return NextResponse.json({ success: true, data: { count: 0 } })
  }

  const db = createServerClient()
  try {
    const sum = rows => (rows || []).reduce((s, c) => s + (c.unread_count || 0), 0)
    const [wa, ig] = await Promise.all([
      db.from('whatsapp_conversations')
        .select('unread_count')
        .eq('location_id', locationId)
        .gt('unread_count', 0),
      db.from('instagram_conversations')
        .select('unread_count')
        .eq('location_id', locationId)
        .gt('unread_count', 0),
    ])
    // A failure on either channel degrades to that channel counting 0
    // rather than erroring the badge.
    const count = sum(wa.error ? [] : wa.data) + sum(ig.error ? [] : ig.data)
    return NextResponse.json({ success: true, data: { count } })
  } catch {
    return NextResponse.json({ success: true, data: { count: 0 } })
  }
}
