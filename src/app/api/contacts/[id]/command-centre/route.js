// GET /api/contacts/[id]/command-centre
//
// UIX-P2 — one-round-trip bundle for the unified inbox's contact
// command centre: the contact row + their recent activity timeline.
// Consent state + audit lines come from the existing sibling routes
// (marketing-preferences, consent-log) so the consent semantics stay
// in exactly one place.
//
// IDOR gate mirrors consent-log: resolve the contact's studio, check
// it against the caller's locations, and answer 404 (not 403) on a
// miss so contact ids can't be enumerated.

import { NextResponse } from 'next/server'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_ACTIVITIES = 20

export async function GET(_request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  }

  const db = createServerClient()
  const { data: contact, error } = await db
    .from('contacts')
    .select('*')
    .eq('id', params.id)
    .maybeSingle()
  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }
  if (!contact) {
    return NextResponse.json({ success: false, error: 'Contact not found' }, { status: 404 })
  }
  const guard = assertLocationAccess(user, contact.location_id)
  if (guard) {
    return NextResponse.json({ success: false, error: 'Contact not found' }, { status: 404 })
  }

  const { data: activities, error: actErr } = await db
    .from('activities')
    .select('*')
    .eq('contact_id', params.id)
    .order('created_at', { ascending: false })
    .limit(MAX_ACTIVITIES)
  if (actErr) {
    return NextResponse.json({ success: false, error: actErr.message }, { status: 500 })
  }

  return NextResponse.json({ success: true, contact, activities: activities || [] })
}
