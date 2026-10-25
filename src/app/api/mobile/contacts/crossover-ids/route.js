// GET /api/mobile/contacts/crossover-ids
//
// ORGCONTACTS.5 (final review I4): the FALLBACK. The phone directory searches
// through /api/mobile/contacts/search (no id cap) and asks for these ids only
// when that route fails or refuses.
//
// UN1THARD.8 / ORGCONTACTS.2 — the phone directory's crossover ids: the
// contacts with a relationship at the active studio whose PRIMARY studio is
// elsewhere (public.studio_contacts, mig 765: contacts joined to their
// contact_studios rows; studio_is_crossover = primary elsewhere). The web
// list reads the same view directly; the phone directory
// (mobile/lib/contacts-api.js searchContacts) reads contacts through RLS
// with location_id = L, so without these ids a Stillorgan member with a
// Hatch relationship was missing from Hatch's phone directory.
//
// Why the route stays (plan deviation, ORGCONTACTS.2): RLS admits a contact
// at EVERY studio where the caller holds Contacts, so a staff member of both
// studios reading `contacts` with no location filter would get the whole
// estate; the phone needs a per-studio filter and the view is closed to
// client sessions. This route returns the ids and nothing else; the rows
// themselves are still read by the phone through RLS, which admits every
// relationship since mig 765, so an id RLS does not admit simply returns no
// row.
//
// Gated on the caller's MOBILE contacts permission at the active studio, the
// same key the directory screen checks. Capped at MOBILE_CROSSOVER_ID_CAP
// (the phone builds an id.in() filter from these: PostgREST sends it as a
// GET URL, and an unbounded list overruns Cloudflare's URI limit → 414).
//
// Auth: Supabase JWT in the Authorization header (getCurrentUser's Bearer
// fallback) + the x-active-location header — same contract as /api/mobile/me.

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { hasMobilePermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { logWarn } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const MOBILE_CROSSOVER_ID_CAP = 100

export async function GET() {
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }

  const locationId = user.activeLocation?.id
  if (!locationId) {
    return NextResponse.json({ success: false, error: 'No active location' }, { status: 400 })
  }

  if (!hasMobilePermission(user, 'contacts')) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  // Best-effort by design: a failed read answers [] and the directory lists
  // the studio's own contacts, as it always has. One page of cap + 1 rows
  // says whether the cap was hit without reading past it.
  const db = createServerClient()
  const { data, error } = await db
    .from('studio_contacts')
    .select('id')
    .eq('studio_location_id', locationId)
    .eq('studio_is_crossover', true)
    .order('id', { ascending: true })
    .range(0, MOBILE_CROSSOVER_ID_CAP)
  if (error) {
    logWarn('mobile-crossover-ids', 'studio_contacts read failed; directory lists own contacts only', { locationId, code: error.code, message: error.message })
    return NextResponse.json({ success: true, data: { ids: [] } })
  }
  const all = (data || []).map((r) => r.id).filter(Boolean)
  if (all.length > MOBILE_CROSSOVER_ID_CAP) {
    logWarn('mobile-crossover-ids', 'crossover ids exceed cap; truncating for URL-length safety', { locationId, cap: MOBILE_CROSSOVER_ID_CAP })
  }
  return NextResponse.json({ success: true, data: { ids: all.slice(0, MOBILE_CROSSOVER_ID_CAP) } })
}
