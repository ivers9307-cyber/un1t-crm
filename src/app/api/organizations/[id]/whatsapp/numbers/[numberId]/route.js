// WAORGNUMBER.1 (Task 5, R8) — one of the organisation's WhatsApp numbers:
// update and delete.
//
// PATCH /api/organizations/[id]/whatsapp/numbers/[numberId]
//   Body: any subset of { label, phone_number_id, access_token,
//   business_account_id, app_id, display_phone, source, is_active,
//   home_location_id }. A token is only written when it is a fresh one (a mask
//   or a blank echoed back is dropped by the schema, N8NECHO.1). The home
//   studio may move, but only to a studio of this organisation (400
//   otherwise). It does not touch the switch-on rows: where the number is
//   switched on is a studio's decision, and the per-studio default is not a
//   number setting.
//
// DELETE /api/organizations/[id]/whatsapp/numbers/[numberId]
//   Hard delete (the number is config, not log data); its switch-on rows go
//   with it by the foreign key's cascade.
//
// Org-admin gated. A number of another organisation is a 404, never a 403, so
// ids cannot be enumerated.

import { NextResponse } from 'next/server'
import { getCurrentUser, assertOrganizationAdmin } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { orgWhatsAppNumberPatchSchema } from '@/lib/schemas'
import { publicShape } from '@/lib/whatsapp-numbers-shape'
import { requireHomeStudioInOrg, duplicateNumberMessage } from '@/lib/org-whatsapp-numbers'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const NOT_FOUND = () => NextResponse.json({ success: false, error: 'Number not found' }, { status: 404 })

// The number, only if it is this organisation's. null = 404 (a read error is a 500).
async function ownNumber(db, orgId, numberId) {
  const { data, error } = await db
    .from('whatsapp_numbers')
    .select('id, organization_id, location_id')
    .eq('id', numberId)
    .eq('organization_id', orgId)
    .maybeSingle()
  if (error) return { response: NextResponse.json({ success: false, error: error.message }, { status: 500 }) }
  if (!data) return { response: NOT_FOUND() }
  return { number: data }
}

export async function PATCH(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  const guard = assertOrganizationAdmin(user, params.id)
  if (guard) return guard

  const result = await validateBody(request, orgWhatsAppNumberPatchSchema)
  if (!result.ok) return result.response
  const { home_location_id: homeLocationId, ...fields } = result.data

  const db = createServerClient()
  const found = await ownNumber(db, params.id, params.numberId)
  if (found.response) return found.response

  const updates = { ...fields, updated_at: new Date().toISOString() }
  if (homeLocationId !== undefined) {
    const home = await requireHomeStudioInOrg(db, params.id, homeLocationId)
    if (!home.ok) return home.response
    updates.location_id = homeLocationId
  }

  const { data, error } = await db
    .from('whatsapp_numbers')
    .update(updates)
    .eq('id', params.numberId)
    .eq('organization_id', params.id)
    .select()
    .single()

  if (error) {
    if (duplicateNumberMessage(error)) {
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
  const guard = assertOrganizationAdmin(user, params.id)
  if (guard) return guard

  const db = createServerClient()
  const found = await ownNumber(db, params.id, params.numberId)
  if (found.response) return found.response

  const { error } = await db
    .from('whatsapp_numbers')
    .delete()
    .eq('id', params.numberId)
    .eq('organization_id', params.id)
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })

  return NextResponse.json({ success: true })
}
