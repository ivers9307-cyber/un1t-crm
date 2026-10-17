// GET /api/mobile/contacts/crossover-ids
//
// UN1THARD.8 — the phone directory's crossover ids. The web contacts list
// shows a studio's own contacts plus its crossovers: people owned by another
// studio who hold an active membership, a un1t.online client row or a deal
// here (crossover_contact_ids, migs 251/731/732). The phone directory
// (mobile/lib/contacts-api.js searchContacts) read contacts directly with
// location_id = L, so a Stillorgan member with a Hatch Street membership was
// missing from Hatch's phone directory while the web list showed them.
//
// The RPC is service_role only, so the phone cannot call it. This route
// returns the ids and nothing else. The contact rows themselves are still
// read by the phone through RLS (migs 731/732 admit a contact at a studio
// where it holds an active membership or a un1t_clients row, for a caller
// holding Contacts there), so RLS stays the read gate: an id RLS does not
// admit (a deal-only crossover) simply returns no row.
//
// Gated on the caller's MOBILE contacts permission at the active studio, the
// same key the directory screen checks. Capped at CROSSOVER_ID_CAP (the
// phone builds an id.in() filter from these).
//
// Auth: Supabase JWT in the Authorization header (getCurrentUser's Bearer
// fallback) + the x-active-location header — same contract as /api/mobile/me.

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { hasMobilePermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { crossoverContactIds } from '@/lib/contact-crossovers'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

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

  // Best-effort by design (crossoverContactIds answers [] on a failed RPC):
  // the directory then lists the studio's own contacts, as it always has.
  const ids = await crossoverContactIds(createServerClient(), locationId)
  return NextResponse.json({ success: true, data: { ids } })
}
