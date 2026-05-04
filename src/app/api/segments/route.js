// GET /api/segments
//
// Lists every known tag from src/lib/contact-events.js TAG_RULES
// alongside the count of currently-active contacts (contact_tags
// rows where removed_at IS NULL) at the user's location(s).
//
// Returns:
//   { success, data: [{ tag, description, count }] }
//
// Manager+ only. Master sees aggregate across all locations.

import { NextResponse } from 'next/server'
import { getCurrentUser, getUserLocationIds } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { MANAGER_ROLES } from '@/lib/schemas'
import { TAG_RULES } from '@/lib/contact-events'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  if (!MANAGER_ROLES.includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Manager+ required' }, { status: 403 })
  }

  const db = createServerClient()
  const locationIds = getUserLocationIds(user)
  if (Array.isArray(locationIds) && locationIds.length === 0) {
    return NextResponse.json({
      success: true,
      data: TAG_RULES.map(r => ({ tag: r.tag, description: r.description, count: 0 })),
    })
  }

  const data = await Promise.all(TAG_RULES.map(async (rule) => {
    let q = db
      .from('contact_tags')
      .select('id', { count: 'exact', head: true })
      .eq('tag', rule.tag)
      .is('removed_at', null)
    if (Array.isArray(locationIds)) {
      q = q.in('location_id', locationIds)
    }
    const { count } = await q
    return { tag: rule.tag, description: rule.description, count: count || 0 }
  }))

  return NextResponse.json({ success: true, data })
}
