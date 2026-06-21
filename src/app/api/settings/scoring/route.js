import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { MANAGER_ROLES } from '@/lib/schemas'
import { resolveScoringConfig, SCORING_DEFAULTS } from '@/lib/heart-rate'

// INCLUSION-CORE T5 — operator editor for the UN1T-Points scoring
// figures. Stored on locations.settings.scoring (jsonb), sibling of
// settings.customer_agent — mirrors that editor's auth gate, active-
// location resolution, and JSONB merge-write exactly. The engine (T1's
// resolveScoringConfig in src/lib/heart-rate.js) reads these; absent
// values fall back to SCORING_DEFAULTS, so an unsaved location keeps the
// hardcoded 1..5 / 50 behaviour.
//
// Stored shape: { zone_points: { "1":n, … "5":n }, participation_points: n }

export const runtime = 'nodejs'

// Sane upper bounds: a per-minute zone rate above 100 or a participation
// award above 1000 is almost certainly a typo, not intent. Floors at 0.
const zonePointsSchema = z.object({
  1: z.number().int().min(0).max(100),
  2: z.number().int().min(0).max(100),
  3: z.number().int().min(0).max(100),
  4: z.number().int().min(0).max(100),
  5: z.number().int().min(0).max(100),
})

export const ScoringSchema = z.object({
  zone_points: zonePointsSchema,
  participation_points: z.number().int().min(0).max(1000),
})

export async function GET() {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  const db = createServerClient()
  const locationId = user.activeLocation?.id
  if (!locationId) return NextResponse.json({ success: false, error: 'No active location' }, { status: 400 })

  const { data: loc } = await db.from('locations').select('name, settings').eq('id', locationId).single()
  // resolveScoringConfig returns camelCase { zonePoints, participationPoints };
  // the page consumes the snake_case stored shape, so re-shape here so GET and
  // PUT speak the same language.
  const resolved = resolveScoringConfig(loc || {})
  const scoring = {
    zone_points: { ...resolved.zonePoints },
    participation_points: resolved.participationPoints,
  }
  return NextResponse.json({
    success: true,
    scoring,
    defaults: SCORING_DEFAULTS,
    location: { id: locationId, name: loc?.name || null },
  })
}

export async function PUT(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!MANAGER_ROLES.includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
  const db = createServerClient()
  const locationId = user.activeLocation?.id
  if (!locationId) return NextResponse.json({ success: false, error: 'No active location' }, { status: 400 })

  // Defence-in-depth: the active location is session-derived, but assert the
  // caller actually holds it before writing.
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard

  const v = await validateBody(request, ScoringSchema)
  if (!v.ok) return v.response

  // Merge into the existing settings object — read current, set the scoring
  // key, write the whole object back so sibling keys (customer_agent,
  // social_enabled, …) are never clobbered. Same approach the customer-agent
  // route uses.
  const { data: loc } = await db.from('locations').select('settings').eq('id', locationId).single()
  const settings = loc?.settings || {}
  const scoring = {
    zone_points: {
      1: v.data.zone_points[1],
      2: v.data.zone_points[2],
      3: v.data.zone_points[3],
      4: v.data.zone_points[4],
      5: v.data.zone_points[5],
    },
    participation_points: v.data.participation_points,
  }
  settings.scoring = scoring

  const { error: updErr } = await db.from('locations').update({ settings }).eq('id', locationId).select('id').single()
  if (updErr) return NextResponse.json({ success: false, error: updErr.message }, { status: 500 })
  return NextResponse.json({ success: true, scoring })
}
