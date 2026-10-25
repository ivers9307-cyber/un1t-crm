// GET /api/xero/debug
// Returns the exact authorize URL, the non-secret Xero env values, and
// presence/length (never a character) of the client id and secret, so we
// can diff against what's registered in the Xero developer portal.
// Owner-only — never expose this in a client UI without the gate.

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { buildAuthorizeUrl, XERO_SCOPES } from '@/lib/xero/client'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  if (user.role !== 'owner' && user.role !== 'master') {
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

  // SECRETTAILS.1 — presence, length and "was it pasted with surrounding
  // whitespace?", never a character. That is the whole question this route
  // answers about a credential ("not blank, not a padded copy/paste"), and
  // it needs neither end of the value.
  const describeEnv = (v) => {
    const s = typeof v === 'string' ? v : ''
    return { present: s.length > 0, length: s.length, surrounding_whitespace: s.length > 0 && s !== s.trim() }
  }

  return NextResponse.json({
    success: true,
    env: {
      XERO_CLIENT_ID: describeEnv(process.env.XERO_CLIENT_ID),
      XERO_CLIENT_SECRET: describeEnv(process.env.XERO_CLIENT_SECRET),
      XERO_REDIRECT_URI: process.env.XERO_REDIRECT_URI || null,
      XERO_SALES_ACCOUNT_CODE: process.env.XERO_SALES_ACCOUNT_CODE || null,
      NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL || null,
    },
    scopes: XERO_SCOPES,
    authorizeUrl,
    buildError,
    // REPSET-P6.S2 — derived from the env, never a hard-coded host: this is
    // the value the OAuth dance actually sends, so it is by definition what
    // must be registered in the Xero portal. A literal here false-alarmed
    // whenever the deployment's host moved ahead of (or behind) the string.
    expectedRedirectUriInXero: process.env.XERO_REDIRECT_URI || null,
    note: 'expectedRedirectUriInXero mirrors XERO_REDIRECT_URI — register EXACTLY that value in the Xero developer portal (no trailing slash, lowercase, https). If it is null, XERO_REDIRECT_URI is unset.',
  })
}
