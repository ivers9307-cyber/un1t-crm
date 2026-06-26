// GET /api/consultations/me — the member's own coach feedback (champ-app).
//
// Customer-authed via the member's Supabase JWT (resolveCustomerContact).
// Returns ONLY the member-shareable fields — the explicit `member_feedback`
// (mig 318), when it was given, and the coach's name — and NEVER the staff-only
// `notes`. Service-role read; there is intentionally no member RLS on
// `consultations`, so `notes` can never leak to the member app.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { resolveCustomerContact } from '@/lib/customer-auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request) {
  const db = createServerClient()

  const { contact, error } = await resolveCustomerContact(request, { db })
  if (error) {
    return NextResponse.json({ success: false, error }, { status: error === 'no_contact' ? 409 : 401 })
  }

  const { data: rows, error: qErr } = await db
    .from('consultations')
    .select('id, consulted_at, member_feedback, coach_id')
    .eq('contact_id', contact.id)
    .not('member_feedback', 'is', null)
    .order('consulted_at', { ascending: false })

  if (qErr) {
    return NextResponse.json({ success: false, error: qErr.message }, { status: 500 })
  }

  // Resolve coach names in one indexed lookup (service-role can read profiles;
  // a member's own client cannot — that's why this is a service-role route).
  const coachIds = [...new Set((rows || []).map((r) => r.coach_id).filter(Boolean))]
  let names = {}
  if (coachIds.length) {
    const { data: coaches } = await db.from('profiles').select('id, full_name').in('id', coachIds)
    names = Object.fromEntries((coaches || []).map((c) => [c.id, c.full_name]))
  }

  const items = (rows || []).map((r) => ({
    id: r.id,
    consulted_at: r.consulted_at,
    member_feedback: r.member_feedback,
    coach_name: names[r.coach_id] || null,
  }))

  return NextResponse.json({ success: true, data: items })
}
