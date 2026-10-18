// WA-MULTI.1 — whatsapp_numbers, location-scoped READ.
//
// GET  /api/locations/[id]/whatsapp/numbers
//   List configured numbers for this location. Returns
//   access_token as a fixed mask (presence only; N8NECHO.1) so the UI
//   can say a token is saved without ever exposing any character of
//   the secret to the browser.
//
// POST /api/locations/[id]/whatsapp/numbers
//   RETIRED (WAORGNUMBER.1): numbers are added at the organisation now —
//   POST /api/organizations/[id]/whatsapp/numbers. Answers 410 with a
//   pointer to /settings/whatsapp-numbers. (Task 6 rewrites this GET to
//   list the numbers switched on at the studio.)

import { NextResponse } from 'next/server'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { publicShape } from '@/lib/whatsapp-numbers-shape'
import { numbersMovedToOrganisation } from '@/lib/org-whatsapp-numbers'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

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

export async function POST() {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  return numbersMovedToOrganisation()
}
