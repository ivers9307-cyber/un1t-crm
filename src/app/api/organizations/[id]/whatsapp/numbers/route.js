// WAORGNUMBER.1 (Task 5, R8) — the organisation's WhatsApp numbers.
//
// A number belongs to the ORGANISATION and is switched on per studio; this
// route is where an organisation admin (or a master) lists and adds them.
//
// GET  /api/organizations/[id]/whatsapp/numbers
//   Every number of the organisation, tokens as the fixed mask (presence
//   only; N8NECHO.1) via publicShape.
//
// POST /api/organizations/[id]/whatsapp/numbers
//   Body: { label, phone_number_id, access_token, business_account_id?,
//           app_id?, display_phone?, source?, home_location_id }
//   home_location_id must be a studio of this organisation (400 otherwise: the
//   database does not refuse another organisation's studio as a home). The
//   number is switched on at its home studio by mig 743's AFTER INSERT trigger
//   (default only when that studio has none yet); this route does NOT insert
//   the link row (R1), it only stamps created_by on it afterwards.
//
// Org-admin gated (assertOrganizationAdmin; a master passes). An owner at one
// studio is not an organisation admin.

import { NextResponse } from 'next/server'
import { getCurrentUser, assertOrganizationAdmin } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { orgWhatsAppNumberCreateSchema } from '@/lib/schemas'
import { publicShape } from '@/lib/whatsapp-numbers-shape'
import { requireHomeStudioInOrg, stampHomeLinkCreatedBy, duplicateNumberMessage } from '@/lib/org-whatsapp-numbers'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Everything publicShape reads (the token and signup_meta stay server-side).
const NUMBER_COLUMNS = 'id, organization_id, location_id, label, phone_number_id, business_account_id, app_id, display_phone, source, token_type, connected_via, is_default, is_active, access_token, signup_meta, created_at, updated_at'

export async function GET(_request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  const guard = assertOrganizationAdmin(user, params.id)
  if (guard) return guard

  const db = createServerClient()
  const { data, error } = await db
    .from('whatsapp_numbers')
    .select(NUMBER_COLUMNS)
    .eq('organization_id', params.id)
    .order('created_at', { ascending: true })

  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })

  return NextResponse.json({ success: true, numbers: (data || []).map(publicShape) })
}

export async function POST(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  const guard = assertOrganizationAdmin(user, params.id)
  if (guard) return guard

  const result = await validateBody(request, orgWhatsAppNumberCreateSchema)
  if (!result.ok) return result.response
  const body = result.data

  const db = createServerClient()
  const home = await requireHomeStudioInOrg(db, params.id, body.home_location_id)
  if (!home.ok) return home.response

  const { data, error } = await db
    .from('whatsapp_numbers')
    .insert({
      organization_id: params.id,
      location_id: body.home_location_id,
      label: body.label,
      phone_number_id: body.phone_number_id,
      access_token: body.access_token,
      business_account_id: body.business_account_id || null,
      app_id: body.app_id || null,
      display_phone: body.display_phone || null,
      source: body.source,
    })
    .select()
    .single()

  if (error) {
    const dup = duplicateNumberMessage(error)
    if (dup) return NextResponse.json({ success: false, error: dup }, { status: 409 })
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }

  await stampHomeLinkCreatedBy(db, { numberId: data.id, locationId: data.location_id, userId: user.id })

  return NextResponse.json({ success: true, number: publicShape(data) })
}
