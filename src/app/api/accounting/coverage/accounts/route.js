// src/app/api/accounting/coverage/accounts/route.js
//
// RCOV CSV bridge — active BANK accounts for the statement-import
// account picker. Live from Xero (accounting.settings scope) so an
// account with zero tracked lines is still selectable.
import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { hasPermission } from '@/lib/permissions'
import { withFreshToken, XeroError } from '@/lib/xero/client'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// accounting_hub at the active studio ('Forbidden' 403), then the active
// studio (400), in that order and with these texts, as before. Any other
// failure is withAuth's fixed 500.
export const GET = withAuth(
  { permission: null, location: false, allow: (user) => hasPermission(user, 'accounting_hub'), forbiddenMessage: 'Forbidden' },
  async ({ user }) => {
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
  },
)
