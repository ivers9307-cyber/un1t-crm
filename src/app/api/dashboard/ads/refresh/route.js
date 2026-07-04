// src/app/api/dashboard/ads/refresh/route.js
// POST { locationId } → run an on-demand ads sync for one location, triggered
// from the /dashboard/ads "Refresh" button. Session-guarded (anyone who can view
// the dashboard can refresh it); mirrors the ad-insights-sync cron scoped to a
// single location. Returns { success, results, synced_at }.
import { NextResponse } from 'next/server'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { syncAccount } from '@/lib/ads/sync'
import * as meta from '@/lib/ads/providers/meta'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const PROVIDERS = { meta }
const BREAKDOWNS = ['publisher_platform', 'age', 'gender']

function dublinDateStr(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000)
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Dublin' }).format(d) // YYYY-MM-DD
}

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  const { locationId } = await request.json().catch(() => ({}))
  if (!locationId) return NextResponse.json({ success: false, error: 'locationId required' }, { status: 400 })
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard
  if (!hasPermission(user, 'dashboard_ads')) return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })

  const db = createServerClient()
  const since = dublinDateStr(-1), until = dublinDateStr(0)
  const { data: accounts } = await db.from('ad_accounts').select('*').eq('location_id', locationId).eq('is_active', true)
  const results = []
  for (const account of accounts || []) {
    try {
      const provider = PROVIDERS[account.provider]
      if (!provider) { results.push({ id: account.id, skipped: 'no_provider' }); continue }
      await syncAccount(db, account, provider, { since, until, breakdowns: account.provider === 'meta' ? BREAKDOWNS : [] })
      await db.from('ad_accounts').update({ last_synced_at: new Date().toISOString(), last_sync_error: null }).eq('id', account.id)
      results.push({ id: account.id, ok: true })
    } catch (e) {
      await db.from('ad_accounts').update({ last_sync_error: e.message }).eq('id', account.id)
      results.push({ id: account.id, error: e.message })
    }
  }
  return NextResponse.json({ success: true, results, synced_at: new Date().toISOString() })
}
