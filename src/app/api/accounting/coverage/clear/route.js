// src/app/api/accounting/coverage/clear/route.js
//
// RCOV — "Clear board": delete every open (non-terminal) bank line for
// the active location. Recovery hatch for a mistaken statement upload.
// Guards per house convention: session → accounting_hub → active
// location. Destructive but recoverable (Refresh from Xero re-pulls
// bt: lines; a re-upload re-adds csv: lines; Xero bills are untouched).
import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { hasPermission } from '@/lib/permissions'
import { clearOpenLines } from '@/lib/recon/clear-board'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST() {
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
  const result = await clearOpenLines(db, locationId, user.id)
  return NextResponse.json({ success: true, data: result })
}
