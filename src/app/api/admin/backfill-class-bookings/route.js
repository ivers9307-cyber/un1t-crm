// POST /api/admin/backfill-class-bookings?location_id=<uuid>
//
// HR-CLASS-ALLOC.2 — one-shot population of the class_bookings roster. The
// nightly glofox-sync + every BOOKING_* webhook already keep it fresh going
// forward (applyMemberSync upserts each member's bookings); this route fills it
// immediately rather than waiting for the next cycle. Pages active members with
// a glofox_member_id, fetches each one's bookings, upserts. Master-only.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { uuidLike } from '@/lib/schemas'
import {
  glofoxCredentialsForLocation,
  missingGlofoxCredentialsForLocation,
  fetchUserBookings,
} from '@/lib/glofox'
import { upsertClassBookings } from '@/lib/class-bookings'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const PAGE_SIZE = 1000
const HARD_LIMIT = 20_000

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user || user.role !== 'master') {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  const url = new URL(request.url)
  const locationId = url.searchParams.get('location_id')
  if (!locationId || !uuidLike.safeParse(locationId).success) {
    return NextResponse.json({ success: false, error: 'Provide ?location_id=<uuid>' }, { status: 400 })
  }
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard

  const db = createServerClient()
  const creds = await glofoxCredentialsForLocation(db, locationId)
  if (missingGlofoxCredentialsForLocation(creds)) {
    return NextResponse.json({ success: false, error: 'Location not connected to Glofox' }, { status: 400 })
  }

  let members = 0
  let upserted = 0
  let pageStart = 0
  for (;;) {
    const pageEnd = Math.min(pageStart + PAGE_SIZE - 1, HARD_LIMIT - 1)
    const { data: page, error } = await db
      .from('contacts')
      .select('id, glofox_member_id, first_name, last_name, name')
      .eq('location_id', locationId)
      .not('glofox_member_id', 'is', null)
      .order('id', { ascending: true })
      .range(pageStart, pageEnd)
    if (error) {
      return NextResponse.json({ success: false, error: error.message, members, upserted }, { status: 500 })
    }
    if (!Array.isArray(page) || page.length === 0) break

    for (const c of page) {
      const bookings = await fetchUserBookings(creds, c.glofox_member_id)
      const out = await upsertClassBookings(db, {
        locationId,
        contactId: c.id,
        glofoxMemberId: c.glofox_member_id,
        memberName: c.name || [c.first_name, c.last_name].filter(Boolean).join(' ') || null,
        bookings,
      })
      members++
      upserted += out.upserted || 0
    }

    if (page.length < PAGE_SIZE) break
    if (pageStart + PAGE_SIZE >= HARD_LIMIT) break
    pageStart += PAGE_SIZE
  }

  return NextResponse.json({ success: true, members, upserted })
}
