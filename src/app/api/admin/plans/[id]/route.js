// PATCH /api/admin/plans/[id] — master-only: plan METADATA only
// (name, active, sort). Slug and kind are immutable after create;
// every number lives on plan_versions and is changed by creating a
// NEW version (POST /api/admin/plans/[id]/versions) — never in place.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withAuth } from '@/lib/with-auth'
import { logError } from '@/lib/log'
import { validateBody, uuidLike } from '@/lib/validate'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const PatchBody = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  active: z.boolean().optional(),
  sort: z.number().int().min(0).max(10000).optional(),
}).refine((b) => Object.keys(b).length > 0, { message: 'Nothing to update' })

// withAuth only signs the caller in (a signed-out call now answers its 401);
// masters only (profiles.role), refused with the same 403 'Master only', here.
export const PATCH = withAuth({ permission: null, location: false }, async ({ user, db, request, params }) => {
  if (user.profileRole !== 'master') {
    return NextResponse.json({ success: false, error: 'Master only' }, { status: 403 })
  }
  const id = params?.id
  if (!uuidLike.safeParse(id).success) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }

  const validation = await validateBody(request, PatchBody)
  if (!validation.ok) return validation.response

  const { data: updated, error } = await db
    .from('plans')
    .update(validation.data)
    .eq('id', id)
    .select()
    .single()

  if (error || !updated) {
    // .single() errors when the id matched nothing — 404, not 500.
    if (!updated) {
      return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
    }
    logError('plans', 'plan update failed', { planId: id, err: error })
    return NextResponse.json({ success: false, error: 'Could not save the plan.' }, { status: 400 })
  }

  return NextResponse.json({ success: true, data: updated })
})
