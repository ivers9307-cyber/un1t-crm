// PATCH /api/admin/plans/[id] — master-only: plan METADATA only
// (name, active, sort). Slug and kind are immutable after create;
// every number lives on plan_versions and is changed by creating a
// NEW version (POST /api/admin/plans/[id]/versions) — never in place.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { validateBody, uuidLike } from '@/lib/validate'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const PatchBody = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  active: z.boolean().optional(),
  sort: z.number().int().min(0).max(10000).optional(),
}).refine((b) => Object.keys(b).length > 0, { message: 'Nothing to update' })

export async function PATCH(request, { params }) {
  const user = await getCurrentUser()
  if (!user || user.profileRole !== 'master') {
    return NextResponse.json({ success: false, error: 'Master only' }, { status: 403 })
  }

  const { id } = await params
  if (!uuidLike.safeParse(id).success) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }

  const validation = await validateBody(request, PatchBody)
  if (!validation.ok) return validation.response

  const db = createServerClient()
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
    return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  }

  return NextResponse.json({ success: true, data: updated })
}
