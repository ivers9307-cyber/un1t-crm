import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser, assertLocationAccessOr404 } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
// HUBDOOR.2 — same role floor as /api/challenges, from the one module the
// page gate and the redirect chain also read (src/lib/challenges-access).
import { CHALLENGE_ADMIN_ROLES } from '@/lib/challenges-access'
import { challengePhase } from '@/lib/challenges'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD')
export const PatchSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  mode: z.enum(['individual', 'collective']).optional(),
  metric: z.enum(['points', 'classes', 'z4plus_minutes']).optional(),
  starts_on: DATE.optional(),
  ends_on: DATE.optional(),
  target: z.number().int().positive().max(100000000).nullable().optional(),
  // Flagship transformation challenge — always individual (enforced against the
  // effective mode in the handler, since a patch may only carry one of the two).
  is_flagship: z.boolean().optional(),
})

function authz(user) {
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  if (!CHALLENGE_ADMIN_ROLES.includes(user.role)) return NextResponse.json({ success: false, error: 'Manager+ required' }, { status: 403 })
  if (!hasPermission(user, 'challenges')) return NextResponse.json({ success: false, error: 'Disabled' }, { status: 403 })
  return null
}

export async function PUT(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  const g = authz(user); if (g) return g
  const db = createServerClient()
  const { data: existing } = await db.from('challenges').select('*').eq('id', params.id).maybeSingle()
  if (!existing) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  const a = assertLocationAccessOr404(user, existing.location_id); if (a) return a
  const validation = await validateBody(request, PatchSchema)
  if (!validation.ok) return validation.response
  let patch = validation.data
  // Once started, only name + target are editable (metric/window/mode/flag would invalidate standings).
  if (challengePhase(existing, Date.now()) !== 'upcoming') patch = { name: patch.name, target: patch.target }
  // A flagship challenge must be individual — check against the effective mode
  // (the patched mode if present, otherwise the existing row's mode).
  const effectiveMode = patch.mode ?? existing.mode
  const effectiveFlagship = patch.is_flagship ?? existing.is_flagship
  if (effectiveFlagship && effectiveMode !== 'individual') {
    return NextResponse.json({ success: false, error: 'A flagship transformation challenge must be an individual challenge.' }, { status: 400 })
  }
  const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined))
  clean.updated_at = new Date().toISOString()
  const { data, error } = await db.from('challenges').update(clean).eq('id', params.id).select().single()
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  return NextResponse.json({ success: true, data })
}

export async function DELETE(_request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  const g = authz(user); if (g) return g
  const db = createServerClient()
  const { data: existing } = await db.from('challenges').select('location_id').eq('id', params.id).maybeSingle()
  if (!existing) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  const a = assertLocationAccessOr404(user, existing.location_id); if (a) return a
  const { error } = await db.from('challenges').delete().eq('id', params.id)
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  return NextResponse.json({ success: true })
}
