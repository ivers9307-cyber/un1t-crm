// GET  /api/admin/plans — master-only: full plan catalogue with
//                          version history (INTEG-C1, mig 413).
// POST /api/admin/plans — master-only: create a new plan (tier or
//                          add-on). Numbers are NOT accepted here —
//                          they live on plan_versions; create the
//                          first version via /api/admin/plans/[id]/versions.
//
// Platform-level surface (like /api/admin/organizations): master role
// only, no per-location scoping. Writes go through the service client;
// RLS on the plans tables is master-read + service-role-write.
//
// withAuth signs the caller in (a signed-out call is its 401; it was this
// route's 403 'Master only' before), then profiles.role master or the same
// 403 'Master only', then the body.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withAuth } from '@/lib/with-auth'
import { logError } from '@/lib/log'
import { PLAN_KINDS } from '@shared/plans'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const CreateBody = z.object({
  slug: z.string().trim().min(1).max(100)
    .regex(/^[a-z0-9]+(_[a-z0-9]+)*$/, 'Slug must be lowercase snake_case (a-z, 0-9, underscores)'),
  name: z.string().trim().min(1, 'Name is required').max(100),
  kind: z.enum(PLAN_KINDS),
  sort: z.number().int().min(0).max(10000).optional(),
})

const isProfileMaster = (user) => user.profileRole === 'master'

export const GET = withAuth({ permission: null, location: false, allow: isProfileMaster, forbiddenMessage: 'Master only' }, async ({ db }) => {
  const { data, error } = await db
    .from('plans')
    .select('*, versions:plan_versions!plan_id(*)')
    .order('sort', { ascending: true })
  if (error) {
    logError('admin-plans', 'plan catalogue read failed', { err: error })
    return NextResponse.json({ success: false, error: 'Could not load the plans. Try again.' }, { status: 500 })
  }

  // Newest version first within each plan — the editor renders history
  // top-down. (Plan catalogue is tiny; no pagination concerns.)
  const plans = (data || []).map((p) => ({
    ...p,
    versions: (p.versions || []).sort((a, b) =>
      b.effective_from.localeCompare(a.effective_from)
    ),
  }))
  return NextResponse.json({ success: true, data: plans })
})

export const POST = withAuth({ permission: null, location: false, allow: isProfileMaster, forbiddenMessage: 'Master only', schema: CreateBody }, async ({ db, input }) => {
  const { slug, name, kind, sort } = input

  const { data: created, error } = await db
    .from('plans')
    .insert({ slug, name, kind, sort: sort ?? (kind === 'addon' ? 100 : 0) })
    .select()
    .single()

  if (error) {
    if (error.code === '23505' || /duplicate key|unique/i.test(error.message || '')) {
      return NextResponse.json({
        success: false,
        error: `A plan with slug "${slug}" already exists.`,
        code: 'duplicate_slug',
      }, { status: 409 })
    }
    logError('admin-plans', 'plan create failed', { slug, err: error })
    return NextResponse.json({ success: false, error: 'Could not create the plan. Try again.' }, { status: 400 })
  }

  return NextResponse.json({ success: true, data: created })
})
