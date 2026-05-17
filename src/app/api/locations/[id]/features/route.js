// PUT /api/locations/[id]/features
//
// Master-only. Replaces the per-location feature toggle map. The
// browser-side write path that <LocationFeatures> used to call
// went through RLS, which let any owner update the column. Per the
// audit, feature toggles are master-only — RLS would need a
// column-level rule to enforce that, so this route is the simpler
// shape: master-gated, service-role write, no RLS surprises.
//
// Body: { features: object }  — replaces the entire JSONB blob.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { canEditLocationFeatures } from '@/lib/staff-access'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const Body = z.object({
  features: z.record(z.unknown()),
})

export async function PUT(request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!canEditLocationFeatures(user)) {
    return NextResponse.json({
      success: false,
      error: 'Only a master account can edit per-location feature toggles.',
    }, { status: 403 })
  }

  const validation = await validateBody(request, Body)
  if (!validation.ok) return validation.response

  const db = createServerClient()
  const { data, error } = await db
    .from('locations')
    .update({ features: validation.data.features, updated_at: new Date().toISOString() })
    .eq('id', params.id)
    .select('id, features')
    .single()
  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  }
  return NextResponse.json({ success: true, data })
}
