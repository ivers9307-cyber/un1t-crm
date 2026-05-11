// /api/landing-page-settings — GET + PUT operator-editable copy +
// media for the public marketing page at /welcome (mig 126, Phase 2
// of landing-page work).
//
// Auth model (refactored from inline role checks → permission key
// 'landing_page' in shared/permissions.js):
//   - Membership: assertLocationAccess() — caller must be assigned
//     to the target location_id, OR master.
//   - Permission: hasPermissionForLocation(user, location_id,
//     'landing_page') — 3-tier resolver: location feature gate →
//     per-user override → role default. Defaults give the perm to
//     owner+master; managers/head-coaches/staff are off by default
//     but can be granted via StaffForm. The location feature gate
//     lets owners disable landing-page editing per location (e.g.
//     CCF Autos doesn't need it).
//   - The /welcome public page reads via the table's RLS public-
//     read policy directly, NOT through this endpoint. Public anon
//     visitors hit no auth here.
//   - RLS write policy on landing_page_settings (mig 126) still
//     gates by master-or-owner role — defense-in-depth at the
//     simpler role level. Even if hasPermissionForLocation evolves
//     in the future to grant landing_page to managers, the RLS
//     ceiling remains owner+master.
//
// Single row per location. Caller passes ?location_id= so master
// (who has multiple locations) can pick which to edit.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { hasPermissionForLocation } from '@/lib/permissions'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'
import { BlocksArraySchema } from '@/lib/landing-page-blocks'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const PillarSchema = z.object({
  number:    z.string().trim().max(20).optional(),
  title:     z.string().trim().max(200).optional(),
  body:      z.string().trim().max(1000).optional(),
  // Mig 127 — optional photo above the pillar number/title.
  photo_url: z.string().url().max(2000).nullable().optional(),
}).strict()

const StatSchema = z.object({
  number: z.string().trim().max(20).optional(),
  label:  z.string().trim().max(200).optional(),
}).strict()

// Mig 127 — gallery items. URL is required (no point storing an
// item without a photo); alt + caption optional. Cap of 24 photos
// per gallery is way more than the layout can comfortably show but
// gives operators headroom for "swap to fresh photos every month"
// workflows without needing schema changes.
const GalleryItemSchema = z.object({
  url:     z.string().url().max(2000),
  alt:     z.string().trim().max(400).nullable().optional(),
  caption: z.string().trim().max(400).nullable().optional(),
}).strict()

const PutSchema = z.object({
  location_id:        uuidLike,
  hero_eyebrow:       z.string().trim().max(200).nullable().optional(),
  hero_headline:      z.string().trim().max(400).nullable().optional(),
  hero_subhead:       z.string().trim().max(400).nullable().optional(),
  hero_subtext:       z.string().trim().max(2000).nullable().optional(),
  booking_slug:       z.string().trim().max(200).nullable().optional(),
  hero_image_url:     z.string().url().max(2000).nullable().optional(),
  // Mig 127 — hero video takes precedence over hero image when set.
  hero_video_url:     z.string().url().max(2000).nullable().optional(),
  pillars:            z.array(PillarSchema).max(6).optional(),
  stats:              z.array(StatSchema).max(6).optional(),
  // Mig 127 — gallery section. NULL title falls back to the default
  // render heading; empty array hides the section entirely.
  gallery_title:      z.string().trim().max(200).nullable().optional(),
  gallery:            z.array(GalleryItemSchema).max(24).optional(),
  // Mig 127 — embed section. embed_url empty/NULL hides the section.
  embed_title:        z.string().trim().max(200).nullable().optional(),
  embed_url:          z.string().url().max(2000).nullable().optional(),
  embed_caption:      z.string().trim().max(400).nullable().optional(),
  testimonial_quote:  z.string().trim().max(2000).nullable().optional(),
  testimonial_author: z.string().trim().max(200).nullable().optional(),
  // Mig 128 — blocks array. When set, the welcome page renders from
  // this instead of the flat columns above. The flat columns stay
  // valid for backward-compat / rollback but the operator form
  // (Phase 3b onwards) writes blocks ONLY.
  blocks:             BlocksArraySchema.nullable().optional(),
  // Mig 129 — site-chrome logo for the top nav. NULL → render the
  // hard-coded UN1T wordmark text. logo_width_px is bounded both
  // here AND by a CHECK constraint in the DB.
  logo_url:           z.string().url().max(2000).nullable().optional(),
  logo_alt:           z.string().trim().max(200).nullable().optional(),
  logo_width_px:      z.number().int().min(40).max(600).nullable().optional(),
}).strict()

export async function GET(request) {
  const user = await getCurrentUser()
  const url = new URL(request.url)
  const locationId = url.searchParams.get('location_id')
  if (!locationId) {
    return NextResponse.json({ success: false, error: 'location_id is required' }, { status: 400 })
  }
  // Membership gate first (returns 401 if !user, 403 if not a
  // member of the target location), then permission gate.
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard
  if (!hasPermissionForLocation(user, locationId, 'landing_page')) {
    return NextResponse.json({ success: false, error: 'Landing page editor not enabled for your role at this location' }, { status: 403 })
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

  // Membership gate then permission gate. Body-derived location_id
  // is validated as uuidLike via the Zod schema above.
  const guard = assertLocationAccess(user, body.location_id)
  if (guard) return guard
  if (!hasPermissionForLocation(user, body.location_id, 'landing_page')) {
    return NextResponse.json({ success: false, error: 'Landing page editor not enabled for your role at this location' }, { status: 403 })
  }

  // Build an upsert payload — only include fields the operator
  // actually sent so a partial save doesn't blow away unrelated
  // columns. (The form sends every field, but other callers might not.)
  const payload = { location_id: body.location_id, updated_by: user.id || null }
  for (const key of [
    'hero_eyebrow','hero_headline','hero_subhead','hero_subtext',
    'booking_slug','hero_image_url','hero_video_url',
    'gallery_title','embed_title','embed_url','embed_caption',
    'testimonial_quote','testimonial_author',
    // Mig 129 — site logo
    'logo_url','logo_alt','logo_width_px',
  ]) {
    if (body[key] !== undefined) payload[key] = body[key]
  }
  if (body.pillars !== undefined) payload.pillars = body.pillars
  if (body.stats   !== undefined) payload.stats   = body.stats
  if (body.gallery !== undefined) payload.gallery = body.gallery
  if (body.blocks  !== undefined) payload.blocks  = body.blocks

  const db = createServerClient()
  const { data, error } = await db
    .from('landing_page_settings')
    .upsert(payload, { onConflict: 'location_id' })
    .select()
    .single()
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })

  return NextResponse.json({ success: true, data })
}
