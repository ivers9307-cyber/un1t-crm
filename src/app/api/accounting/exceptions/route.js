// src/app/api/accounting/exceptions/route.js
//
// RCOV.P2 — the Exceptions tab's data: audit findings F2/F3/F4/F5 +
// stuck queue rows, detected live by src/lib/recon/exceptions.js.
// Service-role client; access enforced here.
import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { getExceptions } from '@/lib/recon/exceptions'
import { logError } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const GET = withAuth({ permission: 'accounting_hub', location: true }, async ({ db, locationId }) => {
  try {
    const data = await getExceptions(db, locationId)
    return NextResponse.json({ success: true, data })
  } catch (err) {
    logError('accounting-exceptions', 'exceptions read failed', { err, locationId })
    return NextResponse.json({ success: false, error: 'Could not load the exceptions. Try again.' }, { status: 500 })
  }
})
