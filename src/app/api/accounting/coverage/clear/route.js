// src/app/api/accounting/coverage/clear/route.js
//
// RCOV — "Clear board": delete every open (non-terminal) bank line for
// the active location. Recovery hatch for a mistaken statement upload.
// Guards per house convention: session → accounting_hub → active
// location. Destructive but recoverable (Refresh from Xero re-pulls
// bt: lines; a re-upload re-adds csv: lines; Xero bills are untouched).
import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { clearOpenLines } from '@/lib/recon/clear-board'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// A failed delete throws; withAuth logs it and answers a fixed 500.
export const POST = withAuth({ permission: 'accounting_hub', location: true }, async ({ user, db, locationId }) => {
  const result = await clearOpenLines(db, locationId, user.id)
  return NextResponse.json({ success: true, data: result })
})
