import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { validateBody, uuidLike } from '@/lib/validate'

const BrandingSchema = z.object({
  location_id: uuidLike.optional(),
  logo_url: z.string().url().max(2000).nullable().optional(),
  favicon_url: z.string().url().max(2000).nullable().optional(),
  company_name: z.string().max(200).nullable().optional(),
  // MAIL-SIG.2 — the studio half of the email signature: phone + the link
  // row every send FROM this studio carries. Same field discipline as the
  // person-level schema; nullable clears it back to personal fallbacks.
  email_signature: z.object({
    phone: z.string().max(60).optional().default(''),
    links: z.array(z.object({
      label: z.string().max(40),
      url: z.string().url().max(300).refine(u => /^https?:\/\//i.test(u), 'http(s) links only'),
    })).max(5).optional().default([]),
  }).strict().nullable().optional(),
})

// GET /api/settings/branding?location_id=xxx — Get branding for a location
export async function GET(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(request.url)
  const locationId = searchParams.get('location_id') || user.activeLocation?.id
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard

  const db = createServerClient()
  // K8 — `.maybeSingle()`: a location that has never had branding saved has no
  // company_settings row, and `data || null` below is the intended answer for
  // it. location_id is uniquely indexed, so at most one row is real.
  const { data } = await db.from('company_settings')
    .select('*')
    .eq('location_id', locationId)
    .maybeSingle()

  return NextResponse.json({ success: true, data: data || null })
}

// PUT /api/settings/branding — Update branding (owner or master)
export async function PUT(request) {
  const user = await getCurrentUser()
  if (!user || (user.role !== 'owner' && user.role !== 'master')) {
    return NextResponse.json({ success: false, error: 'Only owners or master can update branding' }, { status: 403 })
  }

  const validation = await validateBody(request, BrandingSchema)
  if (!validation.ok) return validation.response
  const body = validation.data
  const locationId = body.location_id || user.activeLocation?.id

  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard

  const db = createServerClient()

  // BRANDMERGE.1 — MERGE, don't overwrite. This used to build every column as
  // `body.x ?? null`, and all three are `.optional()` in the schema above, so a
  // caller that sent only `{ company_name }` silently wiped the logo and the
  // favicon and got a 200 back. It was safe only because the one caller today
  // (the branding settings form) happens to post all three every time, which is
  // a property of a component, not of this contract.
  //
  // Merge rather than "require all three": the schema has advertised these as
  // optional since the route shipped, so demanding them would break the
  // contract to fix a bug in it, and it would force any partial caller to GET
  // first and echo back values it does not care about, which is its own way to
  // clobber branding (a stale read wins). Merging keeps the two intents
  // distinct and both expressible: KEY ABSENT means leave it alone, an explicit
  // `null` means clear it, which is how the UI removes a logo.
  //
  // PostgREST's upsert compiles to INSERT … ON CONFLICT DO UPDATE SET over
  // exactly the columns in the payload, so an omitted key is untouched on the
  // update path and NULL on the insert path — no read-modify-write, no race.
  const record = {
    location_id: locationId,
    updated_at: new Date().toISOString(),
    updated_by: user.id,
  }
  for (const field of ['logo_url', 'favicon_url', 'company_name', 'email_signature']) {
    if (field in body) record[field] = body[field]
  }

  // Upsert — create if it doesn't exist, update the supplied columns if it does
  const { data, error } = await db.from('company_settings')
    .upsert(record, { onConflict: 'location_id' })
    .select()
    .single()

  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  return NextResponse.json({ success: true, data })
}
