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
import { safeReturnTo, decodeReturnTo } from '@/lib/xero/return-to'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Redirect target after OAuth. Default: the per-location settings page with
// the Xero tab selected (`?tab=xero` is read by LocationIntegrations); falls
// back to /settings when the flow never yielded a trustworthy location id
// (missing or mismatched state).
//
// `returnTo` (carried through the SIGNED state) OVERRIDES the default when
// present — but ONLY after passing the open-redirect guard again
// (safeReturnTo), so an attacker-supplied absolute/protocol-relative URL can
// never become the post-OAuth redirect target. An invalid returnTo is
// ignored and the default is used. The success/error query params are always
// appended on top, whichever base is chosen.
function settingsUrl(req, locationId, params = {}, returnTo = null) {
  const validated = safeReturnTo(returnTo)
  const u = validated
    ? new URL(validated, req.url)
    : locationId
      ? new URL(`/settings/locations/${locationId}?tab=xero`, req.url)
      : new URL('/settings', req.url)
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v)
  return u
}

export async function GET(req) {
  const url = new URL(req.url)
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  const oauthError = url.searchParams.get('error')
  const cookieState = req.cookies.get('xero_oauth_state')?.value

  // Best-effort location + return_to for error redirects — only trust the
  // values embedded in `state` once it matches the CSRF cookie we set in
  // /api/xero/connect (the cookie binding is what makes return_to
  // tamper-proof; safeReturnTo in settingsUrl is the second-line guard).
  const verified = Boolean(state && cookieState === state)
  const stateParts = verified ? state.split('.') : []
  const stateLocationId = verified ? (stateParts[1] || null) : null
  const stateReturnTo = verified ? decodeReturnTo(stateParts[2]) : null

  const user = await getCurrentUser()
  if (!user) return NextResponse.redirect(new URL('/login', req.url))
  if (user.role !== 'owner' && user.role !== 'master') {
    return NextResponse.redirect(settingsUrl(req, stateLocationId, { error: 'Not permitted' }, stateReturnTo))
  }

  // Clear the cookie regardless of outcome.
  const clearCookie = res => {
    res.cookies.set('xero_oauth_state', '', { maxAge: 0, path: '/' })
    return res
  }

  if (oauthError) {
    return clearCookie(NextResponse.redirect(settingsUrl(req, stateLocationId, { error: `Xero declined: ${oauthError}` }, stateReturnTo)))
  }
  if (!code || !state) {
    return clearCookie(NextResponse.redirect(settingsUrl(req, stateLocationId, { error: 'Missing code/state' }, stateReturnTo)))
  }
  if (!cookieState || cookieState !== state) {
    return clearCookie(NextResponse.redirect(settingsUrl(req, null, { error: 'OAuth state mismatch' })))
  }

  const [, locationId] = state.split('.')
  const returnTo = stateReturnTo // already decoded from the verified state
  if (!locationId) {
    return clearCookie(NextResponse.redirect(settingsUrl(req, null, { error: 'Invalid state' }, returnTo)))
  }

  try {
    const tokens = await exchangeAuthorizationCode(code)
    const tenants = await listConnectedTenants(tokens.access_token)
    if (!tenants.length) {
      return clearCookie(NextResponse.redirect(settingsUrl(req, locationId, { error: 'No Xero tenants returned' }, returnTo)))
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
      return clearCookie(NextResponse.redirect(settingsUrl(req, locationId, { error: `DB error: ${upErr.message}` }, returnTo)))
    }

    // Prime the caches so a freshly-connected location has accounts +
    // tax rates immediately. Best-effort — failures are recorded on the
    // connection row by the helpers; never block the connect redirect.
    try { await pullAccounts(locationId) } catch (e) { console.warn(`[xero connect] accounts sync: ${e?.message || e}`) }
    try { await pullTaxRates(locationId) } catch (e) { console.warn(`[xero connect] tax-rate sync: ${e?.message || e}`) }

    return clearCookie(NextResponse.redirect(settingsUrl(req, locationId, { connected: tenant.tenantName || 'Xero' }, returnTo)))
  } catch (e) {
    const msg = e instanceof XeroError ? e.message : (e.message || String(e))
    return clearCookie(NextResponse.redirect(settingsUrl(req, locationId, { error: msg }, returnTo)))
  }
}
