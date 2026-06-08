import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { exchangeAuthorizationCode, listAccounts, listLocations, GoogleBusinessError } from '@/lib/google-business/client'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function settingsUrl(req, locationId, params = {}) {
  const u = new URL(`/settings/locations/${locationId}`, req.url)
  u.searchParams.set('tab', 'integrations')
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v)
  return u
}

export async function GET(req) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.redirect(new URL('/login', req.url))

  const url = new URL(req.url)
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  const oauthError = url.searchParams.get('error')
  const cookieState = req.cookies.get('gbp_oauth_state')?.value
  const [, locationId] = (state || '').split('.')

  const clear = (res) => { res.cookies.set('gbp_oauth_state', '', { maxAge: 0, path: '/' }); return res }
  const fail = (msg) => clear(NextResponse.redirect(settingsUrl(req, locationId || '', { gbp_error: msg })))

  if (user.role !== 'owner' && user.role !== 'master') return fail('Not permitted')
  if (oauthError) return fail(`Google declined: ${oauthError}`)
  if (!code || !state) return fail('Missing code/state')
  if (!cookieState || cookieState !== state) return fail('OAuth state mismatch')
  if (!locationId) return fail('Invalid state')

  try {
    const tokens = await exchangeAuthorizationCode(code)
    const accounts = await listAccounts(tokens.access_token)
    if (!accounts.length) return fail('No Google Business accounts on this login')
    const account = accounts[0]

    let locationResource = null
    let locationTitle = null
    const locs = await listLocations(tokens.access_token, account.name)
    if (locs.length === 1) {
      locationResource = `${account.name}/${locs[0].name}`
      locationTitle = locs[0].title || null
    }

    const expiresAt = new Date(Date.now() + (tokens.expires_in || 3600) * 1000).toISOString()
    const db = createServerClient()
    const { error: upErr } = await db.from('google_business_connections').upsert({
      location_id: locationId,
      account_resource: account.name,
      location_resource: locationResource,
      location_title: locationTitle,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: expiresAt,
      scopes: tokens.scope || '',
      connected_by: user.id,
    }, { onConflict: 'location_id' })
    if (upErr) return fail(`DB error: ${upErr.message}`)

    return clear(NextResponse.redirect(settingsUrl(req, locationId, { gbp_connected: '1' })))
  } catch (e) {
    const msg = e instanceof GoogleBusinessError ? e.message : (e.message || String(e))
    return fail(msg)
  }
}
