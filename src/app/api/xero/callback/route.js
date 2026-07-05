// Xero OAuth 2.0 callback. Exchanges the authorization code for a
// token set, lists the granted tenants, and stores a connection row
// for the location that initiated the flow.
//
// The same Xero login may grant access to several tenants (e.g. UN1T
// Dublin gym + CCF Autos). v1 picks the first tenant by default; if
// the user wants to attach a different one we can extend this to a
// picker page later. For now, you can re-auth choosing only the org
// you want for that location.

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { exchangeAuthorizationCode, listConnectedTenants, XeroError } from '@/lib/xero/client'
import { pullAccounts } from '@/lib/xero/accounts-sync'
import { pullTaxRates } from '@/lib/xero/tax-rates-sync'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function settingsUrl(req, params = {}) {
  const u = new URL('/settings/integrations', req.url)
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v)
  return u
}

export async function GET(req) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.redirect(new URL('/login', req.url))
  if (user.role !== 'owner' && user.role !== 'master') {
    return NextResponse.redirect(settingsUrl(req, { error: 'Not permitted' }))
  }

  const url = new URL(req.url)
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  const oauthError = url.searchParams.get('error')
  const cookieState = req.cookies.get('xero_oauth_state')?.value

  // Clear the cookie regardless of outcome.
  const clearCookie = res => {
    res.cookies.set('xero_oauth_state', '', { maxAge: 0, path: '/' })
    return res
  }

  if (oauthError) {
    return clearCookie(NextResponse.redirect(settingsUrl(req, { error: `Xero declined: ${oauthError}` })))
  }
  if (!code || !state) {
    return clearCookie(NextResponse.redirect(settingsUrl(req, { error: 'Missing code/state' })))
  }
  if (!cookieState || cookieState !== state) {
    return clearCookie(NextResponse.redirect(settingsUrl(req, { error: 'OAuth state mismatch' })))
  }

  const [, locationId] = state.split('.')
  if (!locationId) {
    return clearCookie(NextResponse.redirect(settingsUrl(req, { error: 'Invalid state' })))
  }

  try {
    const tokens = await exchangeAuthorizationCode(code)
    const tenants = await listConnectedTenants(tokens.access_token)
    if (!tenants.length) {
      return clearCookie(NextResponse.redirect(settingsUrl(req, { error: 'No Xero tenants returned' })))
    }
    // Default behaviour: take the first tenant. The user can re-auth
    // and pick a different org from the Xero consent screen if they
    // want to link a different one. Most users have a single tenant
    // anyway.
    const tenant = tenants[0]

    const expiresAt = new Date(Date.now() + (tokens.expires_in || 1800) * 1000).toISOString()
    const db = createServerClient()
    const { error: upErr } = await db
      .from('xero_connections')
      .upsert({
        location_id: locationId,
        tenant_id: tenant.tenantId,
        tenant_name: tenant.tenantName,
        tenant_type: tenant.tenantType,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: expiresAt,
        scopes: tokens.scope || '',
        connected_by: user.id,
      }, { onConflict: 'location_id' })
    if (upErr) {
      return clearCookie(NextResponse.redirect(settingsUrl(req, { error: `DB error: ${upErr.message}` })))
    }

    // Prime the caches so a freshly-connected location has accounts +
    // tax rates immediately. Best-effort — failures are recorded on the
    // connection row by the helpers; never block the connect redirect.
    try { await pullAccounts(locationId) } catch (e) { console.warn(`[xero connect] accounts sync: ${e?.message || e}`) }
    try { await pullTaxRates(locationId) } catch (e) { console.warn(`[xero connect] tax-rate sync: ${e?.message || e}`) }

    return clearCookie(NextResponse.redirect(settingsUrl(req, { connected: tenant.tenantName || 'Xero' })))
  } catch (e) {
    const msg = e instanceof XeroError ? e.message : (e.message || String(e))
    return clearCookie(NextResponse.redirect(settingsUrl(req, { error: msg })))
  }
}
