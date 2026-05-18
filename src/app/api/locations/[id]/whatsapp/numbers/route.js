// WA-MULTI.1 — CRUD for whatsapp_numbers, location-scoped.
//
// GET  /api/locations/[id]/whatsapp/numbers
//   List configured numbers for this location. Returns
//   access_token in a redacted form (last 6 chars only) so the UI
//   can show "..xxxxxx" without ever exposing the secret to the
//   browser.
//
// POST /api/locations/[id]/whatsapp/numbers
//   Body: { label, phone_number_id, access_token, business_account_id?,
//           app_id?, display_phone?, source?, is_default? }
//   Creates a new row. If is_default=true, atomically flips all
//   other rows for this location to is_default=false (the partial
//   unique index would otherwise reject the insert).
//
// Master-or-owner gated. Master sees every location; owners scoped
// to their own location.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Redact tokens before returning to the client. We never want the
// full token to reach the browser — even though it's behind auth,
// least-privilege says don't ship it at all.
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

export async function GET(_request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  const guard = assertLocationAccess(user, params.id)
  if (guard) return guard

  const db = createServerClient()
  const { data, error } = await db
    .from('whatsapp_numbers')
    .select('*')
    .eq('location_id', params.id)
    .order('is_default', { ascending: false })
    .order('created_at', { ascending: true })

  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })

  return NextResponse.json({
    success: true,
    numbers: (data || []).map(publicShape),
  })
}

const CreateBody = z.object({
  label: z.string().min(1).max(120),
  phone_number_id: z.string().min(1).max(64),
  access_token: z.string().min(20).max(2000),
  business_account_id: z.string().max(64).nullable().optional(),
  app_id: z.string().max(64).nullable().optional(),
  display_phone: z.string().max(32).nullable().optional(),
  source: z.enum(['cloud_api', 'coexistence']).optional().default('cloud_api'),
  is_default: z.boolean().optional().default(false),
})

export async function POST(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  const guard = assertLocationAccess(user, params.id)
  if (guard) return guard
  const roleGuard = guardMasterOrOwner(user, params.id)
  if (roleGuard) return roleGuard

  const raw = await request.json().catch(() => ({}))
  const parsed = CreateBody.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json({
      success: false,
      error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    }, { status: 400 })
  }

  const db = createServerClient()

  // If marking this row as default, flip every other row for the
  // location to is_default=false BEFORE the insert. The partial
  // unique index otherwise rejects a second default. We do these
  // back-to-back rather than in a transaction because Supabase JS
  // doesn't expose explicit transactions — but the worst case if
  // the insert fails after the flip is "no default" which the
  // resolver tolerates (falls through to is_active=true).
  if (parsed.data.is_default) {
    const { error: clearErr } = await db
      .from('whatsapp_numbers')
      .update({ is_default: false })
      .eq('location_id', params.id)
      .eq('is_default', true)
    if (clearErr) {
      return NextResponse.json({ success: false, error: `Failed to clear existing default: ${clearErr.message}` }, { status: 500 })
    }
  }

  const { data, error } = await db
    .from('whatsapp_numbers')
    .insert({
      location_id: params.id,
      label: parsed.data.label.trim(),
      phone_number_id: parsed.data.phone_number_id.trim(),
      access_token: parsed.data.access_token,
      business_account_id: parsed.data.business_account_id || null,
      app_id: parsed.data.app_id || null,
      display_phone: parsed.data.display_phone || null,
      source: parsed.data.source,
      is_default: parsed.data.is_default,
    })
    .select()
    .single()

  if (error) {
    if (/duplicate key|unique constraint/i.test(error.message)) {
      const msg = /phone_number_id/i.test(error.message)
        ? 'This phone_number_id is already registered (Meta IDs are globally unique across the platform).'
        : 'A number with this label already exists at this location.'
      return NextResponse.json({ success: false, error: msg }, { status: 409 })
    }
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }

  return NextResponse.json({ success: true, number: publicShape(data) })
}
