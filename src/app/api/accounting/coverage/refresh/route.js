// src/app/api/accounting/coverage/refresh/route.js
//
// RCOV.P0 — operator-triggered pull for the active location. Doubles
// as the live validation probe for the BankStatement report shape.
// Body { force: true } bypasses the covered-ratio circuit-breaker —
// the documented escape hatch after a legitimate bulk reconcile in
// Xero (otherwise the breaker re-trips until the ratio dilutes).
import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { hasPermission } from '@/lib/permissions'
import { runCoveragePull } from '@/lib/recon/pull'
import { XeroError } from '@/lib/xero/client'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 120

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!hasPermission(user, 'accounting_hub')) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
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

  const db = createServerClient()
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
        { success: false, error: 'Xero connection is missing the reports scope — reconnect Xero in Settings.' },
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
    console.error('[accounting/coverage] refresh pull failed:', e)
    return NextResponse.json({ success: false, error: msg }, { status: 502 })
  }
}
