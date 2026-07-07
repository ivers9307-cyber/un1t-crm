// GET   /api/hosts/[id]        — one host (org-scoped; 404 if not in caller's org)
// PATCH /api/hosts/[id] { … }  — update name / email / booking fee
//
// Auth: Manager+. Detail routes 404 (not 403) on a cross-org id — no IDOR
// enumeration. (EVENTS-HOST.2)

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { HOST_COLS, loadHostForOrg } from '@/lib/hosts'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

async function gate() {
  const user = await getCurrentUser()
  if (!user) return { error: NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 }) }
  if (!['master', 'owner', 'manager'].includes(user.role)) {
    return { error: NextResponse.json({ success: false, error: 'Manager+ required' }, { status: 403 }) }
  }
  const orgId = user.activeOrganization?.id || user.activeLocation?.organization_id || null
  if (!orgId) return { error: NextResponse.json({ success: false, error: 'no_active_organization' }, { status: 400 }) }
  return { user, orgId }
}

const PatchSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  email: z.string().trim().email().max(200).nullable().optional().or(z.literal('')),
  platform_fee_cents: z.number().int().min(0).max(100000).optional(),
}).refine((o) => Object.keys(o).length > 0, { message: 'No fields to update' })

export async function GET(_request, props) {
  const params = await props.params
  const g = await gate()
  if (g.error) return g.error
  const db = createServerClient()
  const host = await loadHostForOrg(db, params.id, g.orgId)
  if (!host) return NextResponse.json({ success: false, error: 'Host not found' }, { status: 404 })
  return NextResponse.json({ success: true, data: host })
}

export async function PATCH(request, props) {
  const params = await props.params
  const g = await gate()
  if (g.error) return g.error
  const v = await validateBody(request, PatchSchema)
  if (!v.ok) return v.response
  const db = createServerClient()
  const host = await loadHostForOrg(db, params.id, g.orgId)
  if (!host) return NextResponse.json({ success: false, error: 'Host not found' }, { status: 404 })

  const updates = {}
  if (v.data.name !== undefined) updates.name = v.data.name
  if (v.data.email !== undefined) updates.email = v.data.email || null
  if (v.data.platform_fee_cents !== undefined) updates.platform_fee_cents = v.data.platform_fee_cents

  const { data, error } = await db
    .from('event_hosts')
    .update(updates)
    .eq('id', host.id)
    .select(HOST_COLS)
    .single()
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  return NextResponse.json({ success: true, data })
}
