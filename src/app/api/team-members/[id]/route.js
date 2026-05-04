// /api/team-members/[id]
//
// PUT    — edit a team member's name / email / role
// DELETE — remove a member from a team
//
// Manager+ at the team's location. Team-member rows have no direct
// location_id, so we resolve via teams.location_id.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { MANAGER_ROLES } from '@/lib/schemas'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const UpdateSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  email: z.string().email().max(320).nullable().optional(),
  role: z.enum(['captain', 'member']).optional(),
})

async function loadMember(db, memberId) {
  return db
    .from('team_members')
    .select(`
      id, team_id, name, email, role, contact_id,
      team:team_id ( id, location_id )
    `)
    .eq('id', memberId)
    .single()
}

export async function PUT(request, { params }) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  if (!MANAGER_ROLES.includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Manager+ required' }, { status: 403 })
  }

  const validation = await validateBody(request, UpdateSchema)
  if (!validation.ok) return validation.response
  const body = validation.data

  const db = createServerClient()
  const { data: member, error: lookupErr } = await loadMember(db, params.id)
  if (lookupErr || !member) {
    return NextResponse.json({ success: false, error: 'Member not found' }, { status: 404 })
  }
  const guard = assertLocationAccess(user, member.team?.location_id)
  if (guard) return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })

  const updates = {}
  if (body.name !== undefined) updates.name = body.name
  if (body.email !== undefined) {
    updates.email = body.email ? body.email.toLowerCase().trim() : null
  }
  if (body.role) updates.role = body.role
  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ success: true, data: { unchanged: true } })
  }

  const { error } = await db
    .from('team_members')
    .update(updates)
    .eq('id', params.id)
  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  }
  return NextResponse.json({ success: true, data: { applied: updates } })
}

export async function DELETE(_request, { params }) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  if (!MANAGER_ROLES.includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Manager+ required' }, { status: 403 })
  }

  const db = createServerClient()
  const { data: member, error: lookupErr } = await loadMember(db, params.id)
  if (lookupErr || !member) {
    return NextResponse.json({ success: false, error: 'Member not found' }, { status: 404 })
  }
  const guard = assertLocationAccess(user, member.team?.location_id)
  if (guard) return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })

  // Don't let the operator nuke the captain — every team needs at
  // least one captain row. Operator should reassign first.
  if (member.role === 'captain') {
    const { count } = await db
      .from('team_members')
      .select('id', { count: 'exact', head: true })
      .eq('team_id', member.team_id)
      .eq('role', 'captain')
    if ((count || 0) <= 1) {
      return NextResponse.json({
        success: false,
        error: 'Cannot remove the only captain. Promote another member first.',
        code: 'last_captain',
      }, { status: 409 })
    }
  }

  const { error } = await db
    .from('team_members')
    .delete()
    .eq('id', params.id)
  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  }
  return NextResponse.json({ success: true })
}
