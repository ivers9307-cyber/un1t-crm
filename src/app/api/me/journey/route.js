// GET /api/me/journey — a champ-app member reads their own first-90-days
// journey (PULSE-90.2). Auth mirrors /api/me/body-metrics: the member's
// Supabase JWT resolves to THEIR contacts row (resolveCustomerContact);
// no staff session involved.
//
// Response: { success: true, data: { journey } } where journey is the
// loadContactJourney row, or null when there's nothing to show (never
// joined / window expired / past the celebration tail) — the app renders
// no card on null. A DB failure is a standard 500; the app treats any
// failure as "no card" too.
//
// NOTE (pulse-scope-no-booking): this payload is progress data only —
// counts, day/week indices, status. No copy, no reservation links.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { resolveCustomerContact } from '@/lib/customer-auth'
import { loadContactJourney } from '@/lib/onboarding-journey-data'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request) {
  const resolved = await resolveCustomerContact(request)
  if (resolved.error) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }

  const db = createServerClient()
  try {
    const journey = await loadContactJourney(db, resolved.contact.id)
    return NextResponse.json({ success: true, data: { journey } })
  } catch (e) {
    return NextResponse.json({ success: false, error: e.message || 'fetch_failed' }, { status: 500 })
  }
}
