// src/app/api/settings/ads/route.js
// GET  ?locationId=…  → masked ad_accounts rows + report_recipients for a location
// PUT  { locationId, provider, external_account_id, access_token, is_active }  → upsert one account
// PUT  { locationId, report_recipients: [email,…] }                            → save report recipients
// Owner/manager/master only. Service-role DB; access enforced in app code.
import { NextResponse } from 'next/server'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { maskAccountRow, buildAccountPatch } from '@/lib/ads/accounts'
import { ADMIN_ROLES } from '@/lib/schemas'
import { logError } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

function sanitizeRecipients(list) {
  const seen = new Set()
  const out = []
  for (const raw of Array.isArray(list) ? list : []) {
    const e = String(raw || '').trim().toLowerCase()
    if (!e || e.length > 320 || !EMAIL_RE.test(e) || seen.has(e)) continue
    seen.add(e)
    out.push(e)
    if (out.length >= 20) break
  }
  return out
}

export async function GET(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  const locationId = new URL(request.url).searchParams.get('locationId')
  if (!locationId) return NextResponse.json({ success: false, error: 'locationId required' }, { status: 400 })
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard
  const db = createServerClient()
  // CHANNELREAD.1 — a failed read is not "no ad account". Answering
  // success:true + data:[] here made the Ads tab render empty forms (Active
  // off) over a live account, and hid the failure from its own banner.
  const { data: accounts, error: accErr } = await db.from('ad_accounts').select('*').eq('location_id', locationId)
  if (accErr) {
    logError('settings-ads', 'ad_accounts read failed', { locationId, err: accErr.message })
    return NextResponse.json({ success: false, error: 'Could not load the ad accounts just now.' }, { status: 500 })
  }
  const { data: locRow, error: locErr } = await db.from('locations').select('settings').eq('id', locationId).maybeSingle()
  if (locErr) {
    logError('settings-ads', 'locations read failed', { locationId, err: locErr.message })
    return NextResponse.json({ success: false, error: 'Could not load the report recipients just now.' }, { status: 500 })
  }
  const existing = locRow?.settings?.ads?.report_recipients
  const report_recipients = Array.isArray(existing) && existing.length ? existing : (user.email ? [user.email] : [])
  return NextResponse.json({ success: true, data: (accounts || []).map(maskAccountRow), report_recipients })
}

export async function PUT(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  const body = await request.json().catch(() => ({}))
  const { locationId } = body
  if (!locationId) return NextResponse.json({ success: false, error: 'locationId required' }, { status: 400 })
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard
  const role = user.isMaster ? 'master' : user.rolesByLocation?.[locationId]
  if (!ADMIN_ROLES.includes(role)) return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  const db = createServerClient()

  // Recipients-save mode.
  if (Array.isArray(body.report_recipients)) {
    const recipients = sanitizeRecipients(body.report_recipients)
    // CHANNELREAD.1 — this writes the WHOLE settings column back. On a failed
    // read `settings` used to become {} and the update wiped every other key
    // (Glofox credentials, UniFi, payments…). A failed read writes nothing.
    const { data: locRow, error: readErr } = await db.from('locations').select('settings').eq('id', locationId).maybeSingle()
    if (readErr) {
      logError('settings-ads', 'settings read before recipients save failed', { locationId, err: readErr.message })
      return NextResponse.json({ success: false, error: 'Could not read this location\'s settings just now, so nothing was saved. Try again.' }, { status: 500 })
    }
    if (!locRow) return NextResponse.json({ success: false, error: 'Location not found' }, { status: 404 })
    const settings = locRow.settings || {}
    const nextSettings = { ...settings, ads: { ...(settings.ads || {}), report_recipients: recipients } }
    const { error } = await db.from('locations').update({ settings: nextSettings, updated_at: new Date().toISOString() }).eq('id', locationId)
    if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })
    return NextResponse.json({ success: true, report_recipients: recipients })
  }

  // Account-upsert mode.
  const { provider } = body
  if (!['meta', 'tiktok'].includes(provider)) {
    return NextResponse.json({ success: false, error: 'valid provider required' }, { status: 400 })
  }
  const patch = buildAccountPatch(body)
  const row = { location_id: locationId, provider, ...patch, updated_at: new Date().toISOString() }
  const { data, error } = await db.from('ad_accounts')
    .upsert(row, { onConflict: 'location_id,provider,external_account_id' })
    .select('*').maybeSingle()
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  return NextResponse.json({ success: true, data: maskAccountRow(data) })
}
