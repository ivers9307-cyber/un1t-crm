// src/app/api/live/[locationId]/contacts/route.js
//
// GET /api/live/[locationId]/contacts?q=<term>  → up to 30 contacts at this
// location matching the term (name or email), for the strap-link member picker.
// Server-side so it reaches ALL members, not just a preloaded slice.
//
// Auth: any staff at the location (mirrors GET /api/live/[locationId]/detections).

import { NextResponse } from 'next/server'
import { getCurrentUser, getUserLocationIds } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ ok: false, error: 'Unauthorised' }, { status: 401 })
  const locationId = params.locationId
  if (!user.isMaster && !getUserLocationIds(user).includes(locationId)) {
    return NextResponse.json({ ok: false, error: 'Location not in your scope' }, { status: 403 })
  }

  const db = createServerClient()
  const rawQ = new URL(request.url).searchParams.get('q') ?? ''
  // Strip percent signs and commas to keep the PostgREST `or` filter safe.
  const q = rawQ.trim().replace(/[%,]/g, '')

  let query = db.from('contacts').select('id, name').eq('location_id', locationId)

  if (q) {
    query = query.or(`name.ilike.%${q}%,email.ilike.%${q}%`)
  }

  const { data: contacts, error } = await query
    .order('name', { ascending: true })
    .limit(30)

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 })

  return NextResponse.json({ ok: true, contacts: contacts || [] })
}
