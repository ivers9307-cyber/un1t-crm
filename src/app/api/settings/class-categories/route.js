// GET  /api/settings/class-categories?location_id= — seen class names + their categories
// PUT  /api/settings/class-categories — upsert set categories / delete cleared ones
//
// SESSION-REPORT.2 — operator tags each class type cardio/strength/conditioning.
// Manager+ gated; service-role writes (RLS on class_categories is SELECT-only for
// authenticated). The match key is normalizeClassName (shared with the report).
//
// withAuth signs the caller in (a signed-out call is its 401; it was a 403
// here) and runs the coarse manager-somewhere check with the same 403
// 'Unauthorized'; the studio and the role there follow, as before.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withAuth } from '@/lib/with-auth'
import { logError } from '@/lib/log'
import { assertLocationAccess, hasRoleAtLocation, hasRoleAtAnyLocation } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { uuidLike, MANAGER_ROLES } from '@/lib/schemas'
import { normalizeClassName } from '@/lib/hr-analytics'
import { loadSeenClassCategories, CLASS_CATEGORY_VALUES } from '@/lib/class-categories'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const managerSomewhere = (user) => hasRoleAtAnyLocation(user, MANAGER_ROLES)

export const GET = withAuth({ permission: null, location: false, allow: managerSomewhere, forbiddenMessage: 'Unauthorized' }, async ({ user, db, request }) => {
  const { searchParams } = new URL(request.url)
  const locationId = searchParams.get('location_id') || user.activeLocation?.id
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard
  // ROLESWEEP.1a — the role is judged at the location being read/written.
  if (!hasRoleAtLocation(user, locationId, MANAGER_ROLES)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  const seen = await loadSeenClassCategories(db, locationId)
  return NextResponse.json({ success: true, seen })
})

const PutSchema = z.object({
  location_id: uuidLike.optional(),
  entries: z.array(z.object({
    class_name: z.string().min(1).max(120),
    category: z.enum(CLASS_CATEGORY_VALUES).nullable(),
  })).max(500),
})

export const PUT = withAuth({ permission: null, location: false, allow: managerSomewhere, forbiddenMessage: 'Unauthorized' }, async ({ user, db, request }) => {
  const validation = await validateBody(request, PutSchema)
  if (!validation.ok) return validation.response
  const body = validation.data
  const locationId = body.location_id || user.activeLocation?.id
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard
  // ROLESWEEP.1a — the role is judged at the location being read/written.
  if (!hasRoleAtLocation(user, locationId, MANAGER_ROLES)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

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
    if (error) {
      logError('class-categories', 'category save failed', { locationId, err: error })
      return NextResponse.json({ success: false, error: 'Could not save the categories. Try again.' }, { status: 400 })
    }
  }
  for (const key of toDelete) {
    const { error } = await db.from('class_categories').delete().eq('location_id', locationId).eq('class_name_normalized', key)
    if (error) {
      logError('class-categories', 'category clear failed', { locationId, err: error })
      return NextResponse.json({ success: false, error: 'Could not save the categories. Try again.' }, { status: 400 })
    }
  }

  return NextResponse.json({ success: true })
})
