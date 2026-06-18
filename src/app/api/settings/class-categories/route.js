// GET  /api/settings/class-categories?location_id= — seen class names + their categories
// PUT  /api/settings/class-categories — upsert set categories / delete cleared ones
//
// SESSION-REPORT.2 — operator tags each class type cardio/strength/conditioning.
// Manager+ gated; service-role writes (RLS on class_categories is SELECT-only for
// authenticated). The match key is normalizeClassName (shared with the report).

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { uuidLike, MANAGER_ROLES } from '@/lib/schemas'
import { normalizeClassName } from '@/lib/hr-analytics'
import { loadSeenClassCategories, CLASS_CATEGORY_VALUES } from '@/lib/class-categories'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request) {
  const user = await getCurrentUser()
  if (!user || !MANAGER_ROLES.includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }
  const { searchParams } = new URL(request.url)
  const locationId = searchParams.get('location_id') || user.activeLocation?.id
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard

  const db = createServerClient()
  const seen = await loadSeenClassCategories(db, locationId)
  return NextResponse.json({ success: true, seen })
}

const PutSchema = z.object({
  location_id: uuidLike.optional(),
  entries: z.array(z.object({
    class_name: z.string().min(1).max(120),
    category: z.enum(CLASS_CATEGORY_VALUES).nullable(),
  })).max(500),
})

export async function PUT(request) {
  const user = await getCurrentUser()
  if (!user || !MANAGER_ROLES.includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }
  const validation = await validateBody(request, PutSchema)
  if (!validation.ok) return validation.response
  const body = validation.data
  const locationId = body.location_id || user.activeLocation?.id
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard

  const db = createServerClient()
  const toUpsert = []
  const toDelete = []
  for (const e of body.entries) {
    const key = normalizeClassName(e.class_name)
    if (!key) continue
    if (e.category) {
      toUpsert.push({
        location_id: locationId,
        class_name: e.class_name.trim(),
        class_name_normalized: key,
        category: e.category,
        updated_at: new Date().toISOString(),
      })
    } else {
      toDelete.push(key)
    }
  }

  if (toUpsert.length > 0) {
    const { error } = await db.from('class_categories').upsert(toUpsert, { onConflict: 'location_id,class_name_normalized' })
    if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  }
  for (const key of toDelete) {
    const { error } = await db.from('class_categories').delete().eq('location_id', locationId).eq('class_name_normalized', key)
    if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  }

  return NextResponse.json({ success: true })
}
