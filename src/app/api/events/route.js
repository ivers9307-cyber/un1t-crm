// /api/events
//
// List + create events. Manager+ permission. Scoped to the caller's
// active location (originally mig 082 as race events; multi-kind
// since mig 122). Permission key is still 'races' internally.
//
// Multi-kind: race_events.kind discriminates between 'race' (the
// original Hyrox-sim shape — multiple waves, team-name required,
// race-day control panel, TV display) and 'workshop' / 'seminar' /
// 'open_day' / 'masterclass' (single time slot, per-seat capture
// without a team name). UI gates on kind; the underlying data shape
// (waves[], allowed_team_sizes, race_payments per-seat) stays the
// same — non-race kinds always submit exactly one synthetic wave.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser, getUserLocationIds, assertLocationAccess } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'
import { toSlug } from '@/lib/slug'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Wave shape used in both create + update. capacity null = unlimited.
const WaveInputSchema = z.object({
  start_time: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, 'Use HH:MM'),
  capacity: z.number().int().positive().max(10000).nullable().optional(),
  label: z.string().max(60).nullable().optional(),
  display_order: z.number().int().nonnegative().optional(),
})

const CreateSchema = z.object({
  location_id: uuidLike,
  // Mig 122: discriminator. Defaults to 'race' so existing operator
  // muscle memory (where every event is a race) keeps working without
  // the form having to send the field.
  kind: z.enum(['race', 'workshop', 'seminar', 'open_day', 'masterclass', 'lead_gen']).optional(),
  // Mig 125: staffing requirement for the studio overview demand
  // classifier. 0-50 (matches DB CHECK). Default 1 (matches DB DEFAULT).
  // Form pre-fills per kind (race=4, workshop=1, etc.) but operator
  // can override.
  staff_required: z.number().int().min(0).max(50).optional(),
  name: z.string().trim().min(1).max(200),
  slug: z.string().trim().min(1).max(120).regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'lowercase kebab-case').optional(),
  description: z.string().max(4000).nullable().optional(),
  // race_date is required for every kind EXCEPT lead_gen (a no-date
  // data-capture form). Enforced per-kind in the superRefine below.
  race_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD').nullable().optional(),
  registration_opens_at: z.string().datetime().nullable().optional(),
  registration_closes_at: z.string().datetime().nullable().optional(),
  allowed_team_sizes: z.array(z.number().int().positive().max(50)).min(1).max(20).optional(),
  active: z.boolean().optional(),
  // Member pricing (mig 084).
  member_pricing_enabled: z.boolean().optional(),
  members_only: z.boolean().optional(),
  // EVENTS-LOC.2: when true, this event shows in every location's list.
  shared: z.boolean().optional(),
  member_fee_cents: z.number().int().nonnegative().nullable().optional(),
  non_member_fee_cents: z.number().int().nonnegative().nullable().optional(),
  payment_currency: z.string().length(3).optional(),
  // Mig 092: up to 3 sponsor/branding logo URLs for the TV display.
  // Schema CHECK caps the array at 6 to leave headroom; UI caps at 3.
  // Each entry must be an http(s) URL (no data: blobs).
  tv_logos: z.array(z.string().url().max(2000)).max(6).optional(),
  // Waves (mig 083) — at least one required for a usable race.
  // Server normalises by start_time ascending; UNIQUE on
  // (race_event_id, start_time) catches duplicates from the DB side.
  waves: z.array(WaveInputSchema).max(50).optional(),
}).superRefine((val, ctx) => {
  // Every kind except lead_gen needs a date AND at least one wave.
  // lead_gen is a pure data-capture form: no date, no waves.
  const kind = val.kind ?? 'race'
  if (kind === 'lead_gen') return
  if (!val.race_date) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['race_date'], message: 'Date is required.' })
  }
  if (!val.waves || val.waves.length < 1) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['waves'], message: 'Add at least one wave.' })
  }
})

export async function GET(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  if (!hasPermission(user, 'races')) {
    return NextResponse.json({ success: false, error: 'Races feature is disabled at this location' }, { status: 403 })
  }

  const url = new URL(request.url)
  const filterLocation = url.searchParams.get('location_id')

  const db = createServerClient()
  const locationIds = filterLocation ? [filterLocation] : getUserLocationIds(user)
  if (locationIds.length === 0) {
    return NextResponse.json({ success: true, data: [] })
  }
  if (filterLocation) {
    const guard = assertLocationAccess(user, filterLocation)
    if (guard) return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  const { data, error } = await db
    .from('race_events')
    .select(`
      id, location_id, name, slug, description, race_date, kind, staff_required,
      registration_opens_at, registration_closes_at,
      allowed_team_sizes, active, created_at, updated_at,
      member_pricing_enabled, member_fee_cents, non_member_fee_cents,
      members_only, payment_currency, shared,
      waves:race_waves ( id, start_time, capacity, label, display_order ),
      registrations:race_registrations ( id, status, race_started_at, race_finished_at, wave_id, team_composition )
    `)
    .in('location_id', locationIds)
    .order('race_date', { ascending: false })

  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  return NextResponse.json({ success: true, data: data || [] })
}

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  if (!hasPermission(user, 'races')) {
    return NextResponse.json({ success: false, error: 'Races feature is disabled at this location' }, { status: 403 })
  }

  const validation = await validateBody(request, CreateSchema)
  if (!validation.ok) return validation.response
  const body = validation.data

  const guard = assertLocationAccess(user, body.location_id)
  if (guard) return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })

  const slug = body.slug || toSlug(body.name)
  if (!slug) {
    return NextResponse.json({
      success: false,
      error: 'Could not derive a valid slug from the name. Provide one explicitly.',
    }, { status: 400 })
  }

  const db = createServerClient()
  const { data, error } = await db
    .from('race_events')
    .insert({
      location_id: body.location_id,
      kind: body.kind ?? 'race',
      staff_required: body.staff_required ?? 1,
      name: body.name,
      slug,
      description: body.description ?? null,
      race_date: body.kind === 'lead_gen' ? null : body.race_date,
      registration_opens_at: body.registration_opens_at ?? null,
      registration_closes_at: body.registration_closes_at ?? null,
      allowed_team_sizes: body.allowed_team_sizes && body.allowed_team_sizes.length > 0
        ? [...body.allowed_team_sizes].sort((a, b) => a - b)
        : [1, 2, 4],
      active: body.active ?? true,
      member_pricing_enabled: body.member_pricing_enabled ?? false,
      members_only: body.members_only ?? false,
      shared: body.shared ?? false,
      // Only persist member_fee_cents when pricing is on — keeps the
      // table consistent ("if you see member_fee, member pricing is enabled").
      member_fee_cents: (body.member_pricing_enabled && body.member_fee_cents != null) ? body.member_fee_cents : null,
      non_member_fee_cents: body.non_member_fee_cents ?? null,
      payment_currency: body.payment_currency ?? 'EUR',
      tv_logos: Array.isArray(body.tv_logos) ? body.tv_logos : [],
    })
    .select()
    .single()

  if (error) {
    if (error.code === '23505' || /duplicate key|already exists|unique/i.test(error.message || '')) {
      return NextResponse.json({
        success: false,
        error: `A race with slug "${slug}" already exists at this location.`,
        code: 'duplicate_slug',
      }, { status: 409 })
    }
    return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  }

  // Insert the waves (mig 083). Sorted by start_time so display_order
  // defaults match temporal order if the operator didn't set them.
  // lead_gen events have no waves — skip the whole block.
  const sortedWaves = [...(body.waves || [])].sort((a, b) => (a.start_time || '').localeCompare(b.start_time || ''))
  if (sortedWaves.length === 0) {
    return NextResponse.json({ success: true, data: { ...data, waves: [] } }, { status: 201 })
  }
  const waveRows = sortedWaves.map((w, i) => ({
    race_event_id: data.id,
    start_time: w.start_time,
    capacity: w.capacity ?? null,
    label: w.label ?? null,
    display_order: w.display_order ?? i,
  }))
  const { data: insertedWaves, error: wavesErr } = await db
    .from('race_waves')
    .insert(waveRows)
    .select()
  if (wavesErr) {
    // Roll back the race insert so a failed wave create doesn't leave
    // an orphaned race_event with no waves (which would break public
    // signup). Best-effort delete; the race is unusable either way.
    await db.from('race_events').delete().eq('id', data.id)
    if (wavesErr.code === '23505' || /duplicate/i.test(wavesErr.message || '')) {
      return NextResponse.json({
        success: false,
        error: 'Two waves can\'t share the same start time.',
        code: 'duplicate_wave_time',
      }, { status: 409 })
    }
    return NextResponse.json({ success: false, error: `Race created but waves failed: ${wavesErr.message}` }, { status: 400 })
  }

  return NextResponse.json({ success: true, data: { ...data, waves: insertedWaves } }, { status: 201 })
}
