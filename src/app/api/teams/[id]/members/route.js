// POST /api/teams/[id]/members
//
// Add a new member to an existing team. Manager+ at the team's
// location. Returns the inserted row.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { MANAGER_ROLES } from '@/lib/schemas'
import { findOrCreateRaceContact } from '@/lib/race-contact-linking'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const Schema = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.string().email().max(320).nullable().optional(),
  role: z.enum(['captain', 'member']).optional(),
})

export async function POST(request, { params }) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  if (!MANAGER_ROLES.includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Manager+ required' }, { status: 403 })
  }

  const validation = await validateBody(request, Schema)
  if (!validation.ok) return validation.response
  const body = validation.data

  const db = createServerClient()
  const { data: team, error: lookupErr } = await db
    .from('teams')
    .select('id, location_id')
    .eq('id', params.id)
    .single()
  if (lookupErr || !team) {
    return NextResponse.json({ success: false, error: 'Team not found' }, { status: 404 })
  }
  const guard = assertLocationAccess(user, team.location_id)
  if (guard) return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })

  const normalisedEmail = body.email ? body.email.toLowerCase().trim() : null
  // Find-or-create the contact row so race results map to a
  // profile (mig 086). Best-effort — null email skips silently.
  const contactId = normalisedEmail
    ? await findOrCreateRaceContact({
        db,
        locationId: team.location_id,
        email: normalisedEmail,
        name: body.name,
      })
    : null

  const { data, error } = await db
    .from('team_members')
    .insert({
      team_id: params.id,
      contact_id: contactId,
      name: body.name,
      email: normalisedEmail,
      role: body.role || 'member',
      // Operator-added members skip member-validation (manual flow,
      // no public form to verify against).
      is_member: false,
      member_validation_status: 'not_applicable',
    })
    .select('id, name, email, role, contact_id')
    .single()
  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  }
  return NextResponse.json({ success: true, data })
}
