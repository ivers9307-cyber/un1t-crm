// GET /api/xero/debug
// Returns the exact authorize URL and env-var values we use, so we
// can diff against what's registered in the Xero developer portal.
// Owner-only — never expose this in a client UI without the gate.

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { buildAuthorizeUrl, XERO_SCOPES } from '@/lib/xero/client'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  if (!hasPermission(user, 'car_processing')) {
    return NextResponse.json({ success: false, error: 'Not permitted' }, { status: 403 })
  }

  const url = new URL(req.url)
  const locationId = url.searchParams.get('location_id') || user.activeLocation?.id || 'no-location'

  // Build a sample authorize URL — same code path /api/xero/connect
  // uses, just without setting the cookie + redirect.
  let authorizeUrl = null
  let buildError = null
  try {
    authorizeUrl = buildAuthorizeUrl({ state: `debug.${locationId}` })
  } catch (e) {
    buildError = e.message
  }

  // Mask the secret — show length + first/last 4 chars so we can
  // verify it's not blank or a whitespace-padded copy/paste.
  const mask = (v) => {
    if (!v) return null
    if (v.length < 12) return `(${v.length} chars)`
    return `${v.slice(0, 4)}…${v.slice(-4)} (${v.length} chars)`
  }

  return NextResponse.json({
    success: true,
    env: {
      XERO_CLIENT_ID: mask(process.env.XERO_CLIENT_ID),
      XERO_CLIENT_SECRET: mask(process.env.XERO_CLIENT_SECRET),
      XERO_REDIRECT_URI: process.env.XERO_REDIRECT_URI || null,
      XERO_SALES_ACCOUNT_CODE: process.env.XERO_SALES_ACCOUNT_CODE || null,
      NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL || null,
    },
    scopes: XERO_SCOPES,
    authorizeUrl,
    buildError,
    expectedRedirectUriInXero: 'https://crm.un1tdublin.com/api/xero/callback',
    note: 'Compare XERO_REDIRECT_URI here with what you registered in the Xero developer portal — they must match EXACTLY (no trailing slash, lowercase, https).',
  })
}
