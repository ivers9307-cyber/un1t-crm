// MOBILE-LAYOUT Phase 2 — a staff member saves their own bottom-bar arrangement
// for a location. The bar is clamped server-side to the user's admin-defined
// allowed∩bar-eligible set at that location (a forged/stale client can't place
// a feature outside the admin's bounds). Per-toggle enablement is re-checked at
// render time by the resolver, so we only enforce the allowed pool here.
import { z } from 'zod'
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'
import { resolveMobileLayout, BAR_ELIGIBLE } from '@shared/mobile-nav'

export const runtime = 'nodejs'

const Schema = z.object({
  location_id: uuidLike,
  bar: z.array(z.string()).max(8), // clamped to ≤3 after the allowed filter
})

export async function PUT(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const validation = await validateBody(request, Schema)
  if (!validation.ok) return validation.response
  const { location_id, bar } = validation.data

  const guard = assertLocationAccess(user, location_id)
  if (guard) return guard

  // The admin-allowed pool at THIS location. enabledKeys = all bar-eligible keys
  // so `allowed` = admin allowed ∩ bar-eligible (render re-clamps to enabled).
  const assignment = user.assignmentsByLocation?.[location_id]
  const override = assignment?.permissions?.mobile?.layout || null
  const role = user.rolesByLocation?.[location_id] || user.role
  const { allowed } = resolveMobileLayout({
    role,
    employmentType: user.employment_type,
    enabledKeys: BAR_ELIGIBLE,
    override,
  })
  const allowedSet = new Set(allowed)

  const cleanBar = [...new Set(bar)].filter(k => allowedSet.has(k)).slice(0, 3)

  const db = createServerClient()
  const { error } = await db
    .from('mobile_bar_prefs')
    .upsert(
      { profile_id: user.id, location_id, bar: cleanBar, updated_at: new Date().toISOString() },
      { onConflict: 'profile_id,location_id' }
    )
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })

  return NextResponse.json({ success: true, bar: cleanBar })
}
