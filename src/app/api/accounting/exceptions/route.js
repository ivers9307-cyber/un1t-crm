// src/app/api/accounting/exceptions/route.js
//
// RCOV.P2 — the Exceptions tab's data: audit findings F2/F3/F4/F5 +
// stuck queue rows, detected live by src/lib/recon/exceptions.js.
// Service-role client; access enforced here.
import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { hasPermission } from '@/lib/permissions'
import { getExceptions } from '@/lib/recon/exceptions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!hasPermission(user, 'accounting_hub')) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
  const locationId = user.activeLocation?.id
  if (!locationId) {
    return NextResponse.json({ success: false, error: 'No active location' }, { status: 400 })
  }

  const db = createServerClient()
  try {
    const data = await getExceptions(db, locationId)
    return NextResponse.json({ success: true, data })
  } catch (e) {
    console.error('[accounting/exceptions]', e)
    return NextResponse.json({ success: false, error: String(e?.message || e) }, { status: 500 })
  }
}
