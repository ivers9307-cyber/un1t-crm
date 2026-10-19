// GET /api/contacts/[id]/mia-purchase-intents
//
// MIAHATCH.6 — what feeds the "Payment link sent" chip on the contact page:
// the payment-link intents Mia has sent this contact, newest first.
//
// This route uses the service-role client, so RLS filters nothing. Two things
// do (ask "what filters this if I delete RLS?"):
//   1. canViewContact: the contact page's own gate. A contact the viewer cannot
//      see answers 404, never 403, so ids cannot be enumerated.
//   2. the location filter: only intents at studios where the viewer holds
//      Contacts (web or phone), AND for this contact. A crossover viewer sees
//      their own studio's link, never another studio's.
//
// Only six columns are ever read. `checkout_url` (a live payment link),
// `success_token_hash`, `entitlement_snapshot` and `outcome` are never selected,
// so they cannot reach a browser.

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { canViewContact, contactStudioIds } from '@/lib/contact-crossovers'
import { logError } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_INTENTS = 20
const NOT_FOUND = () => NextResponse.json({ success: false, error: 'Contact not found' }, { status: 404 })

export async function GET(_request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  }

  const db = createServerClient()
  const { data: contact, error: contactErr } = await db
    .from('contacts')
    .select('id, location_id')
    .eq('id', params.id)
    .maybeSingle()
  if (contactErr) {
    logError('mia-un1t', 'contact read failed for payment-link chip')
    return NextResponse.json({ success: false, error: 'Could not load payment links' }, { status: 500 })
  }
  if (!contact) return NOT_FOUND()
  if (!(await canViewContact(db, user, contact))) return NOT_FOUND()

  const viewerLocIds = contactStudioIds(
    user,
    [...new Set((user.locations || []).map((l) => l?.id).filter(Boolean))],
  )
  if (viewerLocIds.length === 0) {
    return NextResponse.json({ success: true, data: [] })
  }

  const { data: rows, error } = await db
    .from('mia_purchase_intents')
    .select('id, location_id, product_title, status, created_at, expires_at')
    .eq('contact_id', contact.id)
    .in('location_id', viewerLocIds)
    .order('created_at', { ascending: false })
    .limit(MAX_INTENTS)
  if (error) {
    logError('mia-un1t', 'payment-link intents read failed')
    return NextResponse.json({ success: false, error: 'Could not load payment links' }, { status: 500 })
  }

  // Rebuilt field by field: a column the select did not name cannot appear here
  // even if a future edit widens the select by mistake.
  const data = (rows || []).map((r) => ({
    id: r.id,
    location_id: r.location_id,
    product_title: r.product_title,
    status: r.status,
    created_at: r.created_at,
    expires_at: r.expires_at,
  }))
  return NextResponse.json({ success: true, data })
}
