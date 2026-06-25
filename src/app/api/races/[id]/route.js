// /api/races/[id]
//
// Single-race read / update / soft-delete (active=false). Manager+
// at the race's location.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser, assertLocationAccessOr404 } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { MANAGER_ROLES } from '@/lib/schemas'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const WaveInputSchema = z.object({
  // id present = update existing wave; absent = create. (Mig 083)
  // The diff-and-apply path matches by id where present, by start_time
  // for unidentified rows that happen to align with existing waves.
  id: z.string().uuid().optional(),
  start_time: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, 'Use HH:MM'),
  capacity: z.number().int().positive().max(10000).nullable().optional(),
  label: z.string().max(60).nullable().optional(),
  display_order: z.number().int().nonnegative().optional(),
})

const UpdateSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(4000).nullable().optional(),
  race_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  registration_opens_at: z.string().datetime().nullable().optional(),
  registration_closes_at: z.string().datetime().nullable().optional(),
  allowed_team_sizes: z.array(z.number().int().positive().max(50)).min(1).max(20).optional(),
  active: z.boolean().optional(),
  // Member pricing (mig 084).
  member_pricing_enabled: z.boolean().optional(),
  members_only: z.boolean().optional(),
  member_fee_cents: z.number().int().nonnegative().nullable().optional(),
  non_member_fee_cents: z.number().int().nonnegative().nullable().optional(),
  payment_currency: z.string().length(3).optional(),
  // Mig 092: TV-display logos (max 3 in UI, schema allows 6).
  tv_logos: z.array(z.string().url().max(2000)).max(6).optional(),
  // Mig 145 (GLOFOX3.3): editable on update. See POST schema.
  create_in_glofox: z.boolean().optional(),
  // When provided, replaces the wave set entirely (diff-and-apply).
  // Omitting leaves waves untouched. At least one wave required if set.
  waves: z.array(WaveInputSchema).min(1).max(50).optional(),
})

async function loadRace(db, id) {
  return db
    .from('race_events')
    .select(`
      id, location_id, name, slug, description, race_date,
      registration_opens_at, registration_closes_at,
      allowed_team_sizes, active, created_at, updated_at,
      member_pricing_enabled, member_fee_cents, non_member_fee_cents,
      members_only, payment_currency, tv_logos,
      waves:race_waves ( id, start_time, capacity, label, display_order ),
      registrations:race_registrations (
        id, status, race_started_at, race_finished_at, registered_at, wave_id,
        team_composition, active_payment_id,
        teams ( id, name, size, captain_contact_id,
          team_members ( id, name, email, role, is_member, member_validation_status )
        )
      )
    `)
    .eq('id', id)
    .single()
}

export async function GET(_request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  if (!MANAGER_ROLES.includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Manager+ required' }, { status: 403 })
  }
  if (!hasPermission(user, 'races')) {
    return NextResponse.json({ success: false, error: 'Races feature is disabled at this location' }, { status: 403 })
  }

  const db = createServerClient()
  const { data, error } = await loadRace(db, params.id)
  if (error || !data) {
    return NextResponse.json({ success: false, error: 'Race not found' }, { status: 404 })
  }
  const guard = assertLocationAccessOr404(user, data.location_id)
  if (guard) return guard

  return NextResponse.json({ success: true, data })
}

export async function PUT(request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  if (!MANAGER_ROLES.includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Manager+ required' }, { status: 403 })
  }
  if (!hasPermission(user, 'races')) {
    return NextResponse.json({ success: false, error: 'Races feature is disabled at this location' }, { status: 403 })
  }

  const validation = await validateBody(request, UpdateSchema)
  if (!validation.ok) return validation.response
  const body = validation.data

  const db = createServerClient()
  const { data: existing, error: lookupErr } = await db
    .from('race_events')
    .select('id, location_id')
    .eq('id', params.id)
    .single()
  if (lookupErr || !existing) {
    return NextResponse.json({ success: false, error: 'Race not found' }, { status: 404 })
  }
  const guard = assertLocationAccessOr404(user, existing.location_id)
  if (guard) return guard

  // Pull waves out before building the race_events update payload —
  // they go to a different table.
  const wavesInput = body.waves
  const updates = { ...body }
  delete updates.waves
  if (Array.isArray(updates.allowed_team_sizes)) {
    updates.allowed_team_sizes = [...updates.allowed_team_sizes].sort((a, b) => a - b)
  }
  for (const k of Object.keys(updates)) if (updates[k] === undefined) delete updates[k]

  // Race-event scalar updates first (if any).
  if (Object.keys(updates).length > 0) {
    const { error: raceErr } = await db
      .from('race_events')
      .update(updates)
      .eq('id', params.id)
    if (raceErr) {
      return NextResponse.json({ success: false, error: raceErr.message }, { status: 400 })
    }
  }

  // Wave diff-and-apply (mig 083). When the caller submits waves[],
  // it's the new authoritative set:
  //   - Rows with id matching an existing wave  → UPDATE
  //   - Rows with no id (or unmatched id)       → INSERT
  //   - Existing waves not present in the new set → DELETE
  // We fetch existing waves first to compute the delete set. Wave
  // deletes cascade to set race_registrations.wave_id = NULL on any
  // already-registered teams that pointed at the dropped wave —
  // operator should be aware before doing this in a live race.
  if (wavesInput) {
    const { data: existingWaves } = await db
      .from('race_waves')
      .select('id')
      .eq('race_event_id', params.id)
    const existingIds = new Set((existingWaves || []).map(w => w.id))
    const submittedIds = new Set(wavesInput.filter(w => w.id).map(w => w.id))

    // Delete waves not in the submitted set.
    const toDelete = [...existingIds].filter(id => !submittedIds.has(id))
    if (toDelete.length > 0) {
      const { error: delErr } = await db
        .from('race_waves')
        .delete()
        .in('id', toDelete)
      if (delErr) {
        return NextResponse.json({ success: false, error: `Wave delete failed: ${delErr.message}` }, { status: 400 })
      }
    }

    // Apply each submitted wave (insert or update).
    const sorted = [...wavesInput].sort((a, b) => (a.start_time || '').localeCompare(b.start_time || ''))
    for (let i = 0; i < sorted.length; i++) {
      const w = sorted[i]
      const row = {
        start_time: w.start_time,
        capacity: w.capacity ?? null,
        label: w.label ?? null,
        display_order: w.display_order ?? i,
      }
      if (w.id && existingIds.has(w.id)) {
        const { error: upErr } = await db
          .from('race_waves')
          .update(row)
          .eq('id', w.id)
        if (upErr) {
          return NextResponse.json({ success: false, error: `Wave update failed: ${upErr.message}` }, { status: 400 })
        }
      } else {
        const { error: insErr } = await db
          .from('race_waves')
          .insert({ ...row, race_event_id: params.id })
        if (insErr) {
          if (insErr.code === '23505' || /duplicate/i.test(insErr.message || '')) {
            return NextResponse.json({
              success: false,
              error: 'Two waves can\'t share the same start time.',
              code: 'duplicate_wave_time',
            }, { status: 409 })
          }
          return NextResponse.json({ success: false, error: `Wave insert failed: ${insErr.message}` }, { status: 400 })
        }
      }
    }
  }

  // Re-load with waves joined for the response.
  const { data: refreshed } = await loadRace(db, params.id)
  return NextResponse.json({ success: true, data: refreshed })
}

export async function DELETE(_request, props) {
  const params = await props.params;
  // Soft delete via active=false — preserves race_registrations
  // for historical record.
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  if (!MANAGER_ROLES.includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Manager+ required' }, { status: 403 })
  }
  if (!hasPermission(user, 'races')) {
    return NextResponse.json({ success: false, error: 'Races feature is disabled at this location' }, { status: 403 })
  }

  const db = createServerClient()
  const { data: existing } = await db
    .from('race_events')
    .select('id, location_id')
    .eq('id', params.id)
    .single()
  if (!existing) return NextResponse.json({ success: false, error: 'Race not found' }, { status: 404 })
  const guard = assertLocationAccessOr404(user, existing.location_id)
  if (guard) return guard

  const { error } = await db
    .from('race_events')
    .update({ active: false })
    .eq('id', params.id)

  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  return NextResponse.json({ success: true })
}
