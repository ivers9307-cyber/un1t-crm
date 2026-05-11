// /api/landing-page-settings — GET + PUT operator-editable copy +
// media for the public marketing page at /welcome (mig 126, Phase 2
// of landing-page work).
//
// Auth model:
//   - GET: master OR owner at the location, OR public anon. The
//     /welcome public page also reads via the supabase server client
//     which goes through RLS — that uses the table's public-read
//     policy directly, no auth gate here. The auth gate here is
//     mainly so the SETTINGS form (operator-side) gets a clean
//     400/403 instead of an empty response when permissions slip.
//   - PUT: master OR owner ONLY. Same gate as the table's RLS
//     write policy — a hand-crafted PUT from a manager session
//     would land here with a 403 even though service-role bypasses
//     RLS, because we explicitly check the role.
//
// Single row per location. Caller passes ?location_id= so master
// (who has multiple locations) can pick which to edit.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, getUserLocationIds } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const PillarSchema = z.object({
  number: z.string().trim().max(20).optional(),
  title:  z.string().trim().max(200).optional(),
  body:   z.string().trim().max(1000).optional(),
}).strict()

const StatSchema = z.object({
  number: z.string().trim().max(20).optional(),
  label:  z.string().trim().max(200).optional(),
}).strict()

const PutSchema = z.object({
  location_id:        uuidLike,
  hero_eyebrow:       z.string().trim().max(200).nullable().optional(),
  hero_headline:      z.string().trim().max(400).nullable().optional(),
  hero_subhead:       z.string().trim().max(400).nullable().optional(),
  hero_subtext:       z.string().trim().max(2000).nullable().optional(),
  booking_slug:       z.string().trim().max(200).nullable().optional(),
  hero_image_url:     z.string().url().max(2000).nullable().optional(),
  pillars:            z.array(PillarSchema).max(6).optional(),
  stats:              z.array(StatSchema).max(6).optional(),
  testimonial_quote:  z.string().trim().max(2000).nullable().optional(),
  testimonial_author: z.string().trim().max(200).nullable().optional(),
}).strict()

function isMasterOrLocationOwner(user, locationId) {
  if (!user) return false
  if (user.role === 'master') return true
  // Per-location role check via profile_locations.
  const locs = user.locations || []
  const match = locs.find((l) => l.id === locationId)
  return match?.role === 'owner'
}

export async function GET(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })

  const url = new URL(request.url)
  const locationId = url.searchParams.get('location_id')
  if (!locationId) {
    return NextResponse.json({ success: false, error: 'location_id is required' }, { status: 400 })
  }

  // Caller must be a member of the location (or master) to read
  // settings via this auth path. Public reads of the welcome page
  // come through the table's RLS public-read policy directly, not
  // through this endpoint.
  if (user.role !== 'master' && !getUserLocationIds(user).includes(locationId)) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  const db = createServerClient()
  const { data, error } = await db
    .from('landing_page_settings')
    .select('*')
    .eq('location_id', locationId)
    .maybeSingle()
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })

  return NextResponse.json({ success: true, data: data || null })
}

export async function PUT(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })

  const validation = await validateBody(request, PutSchema)
  if (!validation.ok) return validation.response
  const body = validation.data

  if (!isMasterOrLocationOwner(user, body.location_id)) {
    return NextResponse.json({ success: false, error: 'Master or owner required' }, { status: 403 })
  }

  // Build an upsert payload — only include fields the operator
  // actually sent so a partial save doesn't blow away unrelated
  // columns. (The form sends every field, but other callers might not.)
  const payload = { location_id: body.location_id, updated_by: user.id || null }
  for (const key of [
    'hero_eyebrow','hero_headline','hero_subhead','hero_subtext',
    'booking_slug','hero_image_url','testimonial_quote','testimonial_author',
  ]) {
    if (body[key] !== undefined) payload[key] = body[key]
  }
  if (body.pillars !== undefined) payload.pillars = body.pillars
  if (body.stats   !== undefined) payload.stats   = body.stats

  const db = createServerClient()
  const { data, error } = await db
    .from('landing_page_settings')
    .upsert(payload, { onConflict: 'location_id' })
    .select()
    .single()
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })

  return NextResponse.json({ success: true, data })
}
