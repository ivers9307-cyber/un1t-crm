// WA-MULTI.1 — single-number operations.
//
// RETIRED (WAORGNUMBER.1): a number belongs to the organisation, so it is
// edited and removed there — PATCH / DELETE
// /api/organizations/[id]/whatsapp/numbers/[numberId]. Both answer 410 with a
// pointer to the hub's WhatsApp numbers drawer (ORG_NUMBERS_PAGE) (after the signed-out check and the
// path-studio access check every route in this folder makes).

import { NextResponse } from 'next/server'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { numbersMovedToOrganisation } from '@/lib/org-whatsapp-numbers'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function PATCH(_request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  const guard = assertLocationAccess(user, params.id)
  if (guard) return guard
  return numbersMovedToOrganisation()
}

export async function DELETE(_request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  const guard = assertLocationAccess(user, params.id)
  if (guard) return guard
  return numbersMovedToOrganisation()
}
