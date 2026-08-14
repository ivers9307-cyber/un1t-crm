// src/app/api/live/[locationId]/contacts/route.js
//
// GET /api/live/[locationId]/contacts?q=<term>  → up to 30 contacts at this
// location matching the term (name or email), for the strap-link member picker.
// Server-side so it reaches ALL members, not just a preloaded slice.
//
// HR-CLAIM.1 — candidates are ranked: members booked into the class running
// NOW come first (getClassRoster, the same plumbing as the live roster panel),
// tagged `on_roster: true`; the name search fills in behind. Additive — the
// existing consumers (PairModal) only read id + name.
//
// Auth: any staff at the location (mirrors GET /api/live/[locationId]/detections).

import { NextResponse } from 'next/server'
import { getCurrentUser, getUserLocationIds } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { getClassRoster } from '@/lib/class-bookings'
import { rankClaimCandidates } from '@/lib/hr-claim'

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

  const [rosterData, { data: contacts, error }] = await Promise.all([
    getClassRoster(db, { locationId }),
    query.order('name', { ascending: true }).limit(30),
  ])

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 })

  const ranked = rankClaimCandidates({ roster: rosterData.roster, contacts: contacts || [], query: q })
  return NextResponse.json({
    ok: true,
    contacts: ranked,
    class_name: rosterData.occurrence?.class_name ?? null,
  })
}
