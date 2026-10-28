// FEES.1 — GET the fees one member owes at one studio, for the profile card.
// ?location_id=&contact_id=  Session auth + the class_fees permission there.

import { NextResponse } from 'next/server'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { uuidLike } from '@/lib/schemas'
import { canUseClassFees } from '@/lib/class-fees-access'
import { contactOpenFees } from '@/lib/class-fees-run'
import { exemptContactIds } from '@/lib/class-fees-exemptions'
import { logError } from '@/lib/log'

export const runtime = 'nodejs'

export async function GET(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  const url = new URL(request.url)
  const locationId = url.searchParams.get('location_id')
  const contactId = url.searchParams.get('contact_id')
  if (!uuidLike.safeParse(locationId).success || !uuidLike.safeParse(contactId).success) {
    return NextResponse.json({ success: false, error: 'location_id and contact_id are required' }, { status: 400 })
  }
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard
  if (!canUseClassFees(user, locationId)) return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  const db = createServerClient()
  try {
    const fees = await contactOpenFees(db, { locationId, contactId })
    const exempt = (await exemptContactIds(db, locationId, [contactId])).has(contactId)
    const owed = fees.filter((f) => f.status === 'retry_scheduled' || f.status === 'outstanding')
    return NextResponse.json({
      success: true,
      data: { fees, exempt, owed_cents: owed.reduce((s, f) => s + (f.amount_cents || 0), 0) },
    })
  } catch (err) {
    logError('class-fees', 'contact read failed', { locationId, code: err?.code ?? null })
    return NextResponse.json({ success: false, error: 'Could not load fees just now.' }, { status: 500 })
  }
}
