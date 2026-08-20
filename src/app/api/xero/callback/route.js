// Xero OAuth 2.0 callback. Exchanges the authorization code for a
// token set, lists the granted tenants, and stores a connection row
// for the location that initiated the flow.
//
// The same Xero login may grant access to several tenants (e.g. UN1T
// Dublin gym + CCF Autos). ONE LOCATION = ONE XERO ORG, never shared —
// every business here is a separate legal entity, so a tenant bound to
// two locations files one company's bills into another's books.
// XERO-ONE-ORG.1: we refuse any org another location already holds, and
// name the org we did bind so a wrong auto-pick is visible at once. The
// operator can switch it on the settings card without re-doing OAuth.

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { exchangeAuthorizationCode, listConnectedTenants, XeroError } from '@/lib/xero/client'
import { pullAccounts } from '@/lib/xero/accounts-sync'
import { pullTaxRates } from '@/lib/xero/tax-rates-sync'
import { safeReturnTo, decodeReturnTo } from '@/lib/xero/return-to'
import { chooseTenantToBind } from '@/lib/xero/tenant-binding'

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
    // XERO-ONE-ORG.1 — this used to be `const tenant = tenants[0]`, on the
    // stated assumption that "most users have a single tenant anyway". Every
    // business in this estate is a separate legal entity with its own Xero
    // org, and Xero's /connections returns EVERY org the login has ever
    // authorised — so "the first one" was the same org on all three connects,
    // and three locations silently ended up filing bills into one company's
    // books. Nothing was shown to the operator and nothing checked whether the
    // org was already spoken for.
    //
    // Now: never take an org another location holds, and say which one we did
    // take so a wrong auto-pick is visible immediately rather than months later.
    const db = createServerClient()
    const { data: existing } = await db
      .from('xero_connections')
      .select('tenant_id, location_id, locations:location_id ( name )')
    const existingRows = (existing || []).map((r) => ({
      tenant_id: r.tenant_id,
      location_id: r.location_id,
      location_name: r.locations?.name || null,
    }))
    const choice = chooseTenantToBind(tenants, existingRows, locationId)
    if (!choice.ok) {
      const msg = choice.reason === 'all_taken'
        ? `Every Xero organisation this login grants is already connected to another location (${choice.taken.map((t) => `${t.tenantName || t.tenantId} → ${t.claimedBy}`).join(', ')}). Each location needs its own Xero organisation.`
        : 'No Xero tenants returned'
      return clearCookie(NextResponse.redirect(settingsUrl(req, locationId, { error: msg }, returnTo)))
    }
    const tenant = choice.tenant

    const expiresAt = new Date(Date.now() + (tokens.expires_in || 1800) * 1000).toISOString()
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

    // Name the org that was bound. When more than one was free the pick was
    // arbitrary, so say so — that is the moment to catch a wrong binding.
    const connectedMsg = choice.ambiguous
      ? `${tenant.tenantName || 'Xero'} (this login grants ${choice.alternatives.length + 1} organisations — check this is the right one for ${'this location'})`
      : (tenant.tenantName || 'Xero')
    return clearCookie(NextResponse.redirect(settingsUrl(req, locationId, { connected: connectedMsg }, returnTo)))
  } catch (e) {
    const msg = e instanceof XeroError ? e.message : (e.message || String(e))
    return clearCookie(NextResponse.redirect(settingsUrl(req, locationId, { error: msg }, returnTo)))
  }
}
