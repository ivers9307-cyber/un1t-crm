// MEMBERWRITESWEEP.1f — a studio's TVs (session auth; web TV admin + phone).
//
//   GET  ?location_id=  → the studio's TVs, oldest first, each with `content`
//                         (its one tv_content row) or null when idle
//   POST { location_id, label } → register a TV (the token is the database's)
//
// Replaces the direct tv_displays/tv_content reads and the tv_displays insert
// the web TV admin and the staff phone made from a client session under
// nothing but the membership policy (src/lib/tv-admin.js has the finding).
// Gate: tv_displays, web OR mobile, at the studio (src/lib/tv-admin.js).

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import {
  tvAdminAnywhereGate, authoriseTvLocation, mergeTvContent, TvRegisterSchema,
  TV_DISPLAY_COLUMNS, TV_CONTENT_COLUMNS, UNIQUE_VIOLATION, tvConflict, tvServerError,
} from '@/lib/tv-admin'

export const dynamic = 'force-dynamic'

export async function GET(request) {
  const user = await getCurrentUser()
  const coarse = tvAdminAnywhereGate(user)
  if (coarse) return coarse

  const locationId = new URL(request.url).searchParams.get('location_id') || user.activeLocation?.id
  const gate = authoriseTvLocation(user, locationId)
  if (gate) return gate

  const db = createServerClient()
  const { data: displays, error } = await db.from('tv_displays')
    .select(TV_DISPLAY_COLUMNS)
    .eq('location_id', locationId)
    .order('created_at', { ascending: true })
  if (error) return tvServerError('Could not load the TVs')
  if (!displays || displays.length === 0) return NextResponse.json({ success: true, data: [] })

  const { data: contents, error: contentError } = await db.from('tv_content')
    .select(TV_CONTENT_COLUMNS)
    .in('tv_display_id', displays.map((d) => d.id))
  // Never answer "idle" for a TV whose content we could not read.
  if (contentError) return tvServerError('Could not load what the TVs are showing')

  return NextResponse.json({ success: true, data: mergeTvContent(displays, contents) })
}

export async function POST(request) {
  const user = await getCurrentUser()
  const coarse = tvAdminAnywhereGate(user)
  if (coarse) return coarse

  const validation = await validateBody(request, TvRegisterSchema)
  if (!validation.ok) return validation.response
  const { location_id: locationId, label } = validation.data

  const gate = authoriseTvLocation(user, locationId)
  if (gate) return gate

  const db = createServerClient()
  const { data, error } = await db.from('tv_displays')
    .insert({ location_id: locationId, label })
    .select(TV_DISPLAY_COLUMNS)
    .single()
  if (error) {
    if (error.code === UNIQUE_VIOLATION) return tvConflict(`A TV called "${label}" is already registered here.`)
    return tvServerError(`Could not register the TV: ${error.message}`)
  }
  if (!data) return tvServerError('Could not register the TV')

  return NextResponse.json({ success: true, data: { ...data, content: null } })
}
