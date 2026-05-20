// CAR-SALES-ACCOUNT.1 — POST /api/locations/[id]/xero/car-sales-account
//
// Saves the location's choice of Xero account for car-invoice
// pushes. The picker in Settings → Xero card sources options from
// the cached xero_accounts table (mig 186). Stored on
// xero_connections.car_sales_account_code (mig 188).
//
// Body: { account_code: string | null }  — null clears the override.
//
// Auth: location membership (master + members allowed). Same
// posture as the existing /sync-accounts + /sync-contacts routes.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const Body = z.object({
  account_code: z.string().min(1).max(50).nullable(),
})

export async function POST(request, props) {
  const params = await props.params
  const locationId = params?.id
  if (!locationId) {
    return NextResponse.json({ success: false, error: 'location id required' }, { status: 400 })
  }

  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  const isMaster = user.role === 'master'
  const userLocationIds = (user.locations || []).map((l) => l.id)
  if (!isMaster && !userLocationIds.includes(locationId)) {
    return NextResponse.json({ success: false, error: 'Not a member of that location' }, { status: 403 })
  }

  const raw = await request.json().catch(() => ({}))
  const parsed = Body.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json({
      success: false,
      error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    }, { status: 400 })
  }

  const db = createServerClient()
  const { error } = await db
    .from('xero_connections')
    .update({ car_sales_account_code: parsed.data.account_code })
    .eq('location_id', locationId)
  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }
  return NextResponse.json({ success: true, account_code: parsed.data.account_code })
}
