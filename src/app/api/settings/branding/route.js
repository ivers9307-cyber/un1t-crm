import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess, guardMasterOrOwner } from '@/lib/auth'
import { validateBody, uuidLike } from '@/lib/validate'
import { httpUrl } from '@/lib/schemas'

const BrandingSchema = z.object({
  location_id: uuidLike.optional(),
  // HYGIENE-PII.1 — http(s) only; these render into <img src> / <link rel=icon>.
  logo_url: httpUrl.nullable().optional(),
  favicon_url: httpUrl.nullable().optional(),
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

// PUT /api/settings/branding — Update branding (owner or master AT THE TARGET)
export async function PUT(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const validation = await validateBody(request, BrandingSchema)
  if (!validation.ok) return validation.response
  const body = validation.data
  const locationId = body.location_id || user.activeLocation?.id

  // No target, no write: a caller with no active location and no explicit
  // location_id would otherwise reach the upsert with location_id undefined
  // (a DB refusal for masters, a confusing role 403 for everyone else).
  // Also keeps the caller×target matrix total.
  if (!locationId) {
    return NextResponse.json({ success: false, error: 'location_id is required' }, { status: 400 })
  }

  // MAILFIX-BRANDGATE.1 — gate on the role AT THE TARGET STUDIO, never on
  // `user.role`. That field resolves at the caller's ACTIVE location (with a
  // highest-role-anywhere fallback), while this write lands on the
  // caller-named body.location_id — so the old `user.role` check let an owner
  // at studio A who is plain STAFF at studio B set B's email_signature (the
  // phone + link row MAIL-SIG.2 injects into every customer email B sends),
  // logo and company name. Same shape and order as guardMailboxAdmin:
  // membership first, so an owner of a DIFFERENT studio is told "not one of
  // your locations" rather than a role complaint that confirms the studio
  // exists — guardMasterOrOwner does not check membership (a master belongs
  // nowhere), so assertLocationAccess is kept, not subsumed. Role miss keeps
  // this route's own copy over the guard's generic one.
  const locationGuard = assertLocationAccess(user, locationId)
  if (locationGuard) return locationGuard
  const roleGuard = guardMasterOrOwner(user, locationId)
  if (roleGuard) {
    return NextResponse.json({ success: false, error: 'Only owners or master can update branding' }, { status: 403 })
  }

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
