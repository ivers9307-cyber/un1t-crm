// src/app/api/accounting/coverage/refresh/route.js
//
// RCOV.P0 — operator-triggered pull for the active location. Doubles
// as the live validation probe for the BankStatement report shape.
// Body { force: true } bypasses the covered-ratio circuit-breaker —
// the documented escape hatch after a legitimate bulk reconcile in
// Xero (otherwise the breaker re-trips until the ratio dilutes).
import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { hasPermission } from '@/lib/permissions'
import { logError } from '@/lib/log'
import { runCoveragePull } from '@/lib/recon/pull'
import { XeroError } from '@/lib/xero/client'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 120

// accounting_hub at the active studio ('Forbidden' 403), then the active
// studio (400), in that order and with these texts, as before. A pull that
// fails for any reason other than the three named ones is logged and answered
// with a fixed 502 (it used to return the error text).
export const POST = withAuth(
  { permission: null, location: false, allow: (user) => hasPermission(user, 'accounting_hub'), forbiddenMessage: 'Forbidden' },
  async ({ request, user, db }) => {
    const locationId = user.activeLocation?.id
    if (!locationId) {
      return NextResponse.json({ success: false, error: 'No active location' }, { status: 400 })
    }

    let force = false
    try {
      const body = await request.json()
      force = body?.force === true
    } catch {
      // empty body is fine — force defaults off
    }

    try {
      const summary = await runCoveragePull(db, locationId, {
        trigger: 'manual',
        acceptMassCover: force,
      })
      return NextResponse.json({ success: true, data: summary })
    } catch (e) {
      // Branch on machine-readable .code (recon errors) / .status
      // (XeroError), never on message prose.
      const msg = String(e?.message || e)
      if (e instanceof XeroError && (e.status === 403 || e.status === 401)) {
        return NextResponse.json(
          { success: false, error: 'Xero connection is missing the bank-statement scope — reconnect Xero in Settings to grant it.' },
          { status: 409 }
        )
      }
      if (e?.code === 'recon_pull_running') {
        return NextResponse.json({ success: false, error: msg }, { status: 409 })
      }
      if (e?.code === 'recon_cover_guard') {
        return NextResponse.json(
          { success: false, error: `${msg} — if this follows a deliberate bulk reconcile in Xero, retry with { "force": true }.` },
          { status: 409 }
        )
      }
      logError('accounting-coverage', 'refresh pull failed', { locationId, err: e })
      return NextResponse.json({ success: false, error: 'The coverage pull failed. Try again.' }, { status: 502 })
    }
  },
)
