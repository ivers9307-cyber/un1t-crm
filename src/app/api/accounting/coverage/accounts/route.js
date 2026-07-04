// src/app/api/accounting/coverage/accounts/route.js
//
// RCOV CSV bridge — active BANK accounts for the statement-import
// account picker. Live from Xero (accounting.settings scope) so an
// account with zero tracked lines is still selectable.
import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { withFreshToken, XeroError } from '@/lib/xero/client'

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

  try {
    const { xfetch } = await withFreshToken(locationId)
    const res = await xfetch('/Accounts?where=' + encodeURIComponent('Type=="BANK"'))
    const accounts = (res?.Accounts || [])
      .filter((a) => a.Status === 'ACTIVE')
      .map((a) => ({ id: a.AccountID, name: a.Name }))
    return NextResponse.json({ success: true, data: { accounts } })
  } catch (e) {
    if (e instanceof XeroError) {
      return NextResponse.json(
        { success: false, error: 'Xero is not connected for this location — connect it in Settings first.' },
        { status: 409 }
      )
    }
    throw e
  }
}
