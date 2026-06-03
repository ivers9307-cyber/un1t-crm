// GET /api/whatsapp/unread-count
//
// SIDEBAR-BADGES.1 — sidebar badge count for the Communications hub:
// total unread WhatsApp messages across conversations at the active
// location. Sums whatsapp_conversations.unread_count exactly like the
// Studio dashboard's `totalUnreadWhatsapp` KPI (shared/dashboard-data.js)
// so the two surfaces never disagree. Follows the { success, data:
// { count } } envelope the Sidebar's usePolledCount expects; returns 0
// for users without the whatsapp permission (or no active location).
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
    const { data, error } = await db
      .from('whatsapp_conversations')
      .select('unread_count')
      .eq('location_id', locationId)
      .gt('unread_count', 0)
    if (error) {
      return NextResponse.json({ success: true, data: { count: 0 } })
    }
    const count = (data || []).reduce((sum, c) => sum + (c.unread_count || 0), 0)
    return NextResponse.json({ success: true, data: { count } })
  } catch {
    return NextResponse.json({ success: true, data: { count: 0 } })
  }
}
