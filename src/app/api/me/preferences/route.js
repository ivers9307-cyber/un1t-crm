// /api/me/preferences — self-service preference updates.
//
// Distinct from /api/staff/[id] (which is admin-gated for full
// profile edits). This route only mutates user-personal preferences
// stored under profiles.permissions — anything an owner /
// manager /head_coach / staff member is allowed to change for
// themselves without needing admin approval.
//
// Currently supported keys:
//   - landing_preference: which dashboard /dashboard redirects to
//     ('auto' | 'personal' | 'studio' | 'business')
//
// Authorization model:
//   - Any authenticated user.
//   - Mutates ONLY their own row (profiles.id = user.id) — there's
//     no `id` parameter, the caller can't edit anyone else.
//   - Permission validation is best-effort — if a user picks a
//     dashboard they don't have access to, we still store the
//     preference. The /dashboard redirect then falls through to the
//     smart-default chain. This avoids a confusing rejection in the
//     UI when an owner toggles their own dashboard_business off and
//     forgets they had it set as their landing.
//
// Returns: { success: true, data: { permissions } } so the caller
// can update its local state without a refetch.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { LANDING_PREFERENCE_VALUES } from '@shared/permissions'

export const runtime = 'nodejs'

const PreferencesSchema = z.object({
  landing_preference: z.enum(LANDING_PREFERENCE_VALUES).optional(),
}).strict()

export async function PATCH(request) {
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }

  const validation = await validateBody(request, PreferencesSchema)
  if (!validation.ok) return validation.response
  const body = validation.data

  // Build a minimal merge object — only set keys the caller actually
  // sent. Future preference keys plug in here.
  const patch = {}
  if (body.landing_preference !== undefined) {
    patch.landing_preference = body.landing_preference
  }
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ success: false, error: 'No preference fields to update' }, { status: 400 })
  }

  const db = createServerClient()

  // Read-modify-write of the JSONB. Single-user single-key edits
  // collide with themselves only — last write wins, acceptable for
  // a personal preference. The whole-blob update preserves any
  // admin-set keys (mobile.*, dashboard_*, etc.) untouched.
  const { data: current, error: readErr } = await db
    .from('profiles')
    .select('permissions')
    .eq('id', user.id)
    .single()
  if (readErr) {
    return NextResponse.json({ success: false, error: readErr.message }, { status: 400 })
  }

  const merged = { ...(current?.permissions || {}), ...patch }

  const { error: writeErr } = await db
    .from('profiles')
    .update({ permissions: merged })
    .eq('id', user.id)
  if (writeErr) {
    return NextResponse.json({ success: false, error: writeErr.message }, { status: 400 })
  }

  return NextResponse.json({ success: true, data: { permissions: merged } })
}
