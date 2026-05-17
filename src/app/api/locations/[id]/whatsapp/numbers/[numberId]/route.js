// WA-MULTI.1 — single-number operations: update + delete.
//
// PATCH /api/locations/[id]/whatsapp/numbers/[numberId]
//   Body: any subset of CreateBody — partial update. Tokens are
//   only written when explicitly included (avoids accidentally
//   clobbering with the redacted display value).
//
// DELETE /api/locations/[id]/whatsapp/numbers/[numberId]
//   Hard delete. The row is locked to this location's tenant via
//   the SELECT-then-DELETE pattern. Doesn't soft-delete because
//   whatsapp_numbers is config, not log data.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function redactToken(token) {
  if (!token || typeof token !== 'string') return null
  if (token.length <= 8) return '••••'
  return `••••${token.slice(-6)}`
}

function publicShape(row) {
  return {
    id: row.id,
    location_id: row.location_id,
    label: row.label,
    phone_number_id: row.phone_number_id,
    business_account_id: row.business_account_id,
    app_id: row.app_id,
    display_phone: row.display_phone,
    source: row.source,
    is_default: row.is_default,
    is_active: row.is_active,
    access_token_redacted: redactToken(row.access_token),
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

function guardMasterOrOwner(user, locationId) {
  if (user.profileRole === 'master') return null
  const role = user.rolesByLocation?.[locationId]
  if (role === 'owner') return null
  return NextResponse.json({ success: false, error: 'Master or owner role required.' }, { status: 403 })
}

const PatchBody = z.object({
  label: z.string().min(1).max(120).optional(),
  phone_number_id: z.string().min(1).max(64).optional(),
  access_token: z.string().min(20).max(2000).optional(),
  business_account_id: z.string().max(64).nullable().optional(),
  app_id: z.string().max(64).nullable().optional(),
  display_phone: z.string().max(32).nullable().optional(),
  source: z.enum(['cloud_api', 'coexistence']).optional(),
  is_default: z.boolean().optional(),
  is_active: z.boolean().optional(),
})

export async function PATCH(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  const guard = assertLocationAccess(user, params.id)
  if (guard) return guard
  const roleGuard = guardMasterOrOwner(user, params.id)
  if (roleGuard) return roleGuard

  const raw = await request.json().catch(() => ({}))
  const parsed = PatchBody.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json({
      success: false,
      error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    }, { status: 400 })
  }

  const db = createServerClient()

  // Verify the number belongs to this location (defence-in-depth
  // alongside RLS).
  const { data: existing } = await db
    .from('whatsapp_numbers')
    .select('id, location_id')
    .eq('id', params.numberId)
    .single()
  if (!existing || existing.location_id !== params.id) {
    return NextResponse.json({ success: false, error: 'Number not found' }, { status: 404 })
  }

  // If flipping this row to default, clear any other defaults at
  // this location first (partial unique index enforces "one
  // default per location").
  if (parsed.data.is_default === true) {
    await db
      .from('whatsapp_numbers')
      .update({ is_default: false })
      .eq('location_id', params.id)
      .eq('is_default', true)
      .neq('id', params.numberId)
  }

  const updates = { ...parsed.data, updated_at: new Date().toISOString() }

  const { data, error } = await db
    .from('whatsapp_numbers')
    .update(updates)
    .eq('id', params.numberId)
    .select()
    .single()

  if (error) {
    if (/duplicate key|unique constraint/i.test(error.message)) {
      return NextResponse.json({ success: false, error: 'Phone number ID or label already in use.' }, { status: 409 })
    }
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }

  return NextResponse.json({ success: true, number: publicShape(data) })
}

export async function DELETE(_request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  const guard = assertLocationAccess(user, params.id)
  if (guard) return guard
  const roleGuard = guardMasterOrOwner(user, params.id)
  if (roleGuard) return roleGuard

  const db = createServerClient()
  const { data: existing } = await db
    .from('whatsapp_numbers')
    .select('id, location_id')
    .eq('id', params.numberId)
    .single()
  if (!existing || existing.location_id !== params.id) {
    return NextResponse.json({ success: false, error: 'Number not found' }, { status: 404 })
  }

  const { error } = await db
    .from('whatsapp_numbers')
    .delete()
    .eq('id', params.numberId)
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })

  return NextResponse.json({ success: true })
}
