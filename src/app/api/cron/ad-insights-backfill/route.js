// src/app/api/cron/ad-insights-backfill/route.js
// Manual one-time backfill: pull historical insights for every active account.
// Auth: Bearer CRON_SECRET. NOT scheduled (no vercel.json entry, no heartbeat).
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { syncAccount } from '@/lib/ads/sync'
import * as meta from '@/lib/ads/providers/meta'
import { adAccountDay } from '@/lib/ads/account-day'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const PROVIDERS = { meta }
const BREAKDOWNS = ['publisher_platform', 'age', 'gender']


export async function GET(request) {
  const auth = request.headers.get('authorization') || ''
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  }
  const url = new URL(request.url)
  const sinceParam = url.searchParams.get('since')
  const untilParam = url.searchParams.get('until')
  const nowMs = Date.now()
  const db = createServerClient()
  // TZ.11c: the default window is 30 days in EACH account's own zone (Meta
  // dates insights in the ad account's timezone); explicit params apply as given.
  const { data: accounts } = await db.from('ad_accounts').select('*, locations(id, timezone)').eq('is_active', true)
  const results = []
  for (const account of accounts || []) {
    try {
      const provider = PROVIDERS[account.provider]
      if (!provider) { results.push({ id: account.id, skipped: 'no_provider' }); continue }
      const since = sinceParam || adAccountDay(account, { nowMs, offsetDays: -30 })
      const until = untilParam || adAccountDay(account, { nowMs })
      await syncAccount(db, account, provider, { since, until, breakdowns: account.provider === 'meta' ? BREAKDOWNS : [] })
      await db.from('ad_accounts').update({ last_synced_at: new Date().toISOString(), last_sync_error: null }).eq('id', account.id)
      results.push({ id: account.id, ok: true, since, until })
    } catch (e) {
      await db.from('ad_accounts').update({ last_sync_error: e.message }).eq('id', account.id)
      results.push({ id: account.id, error: e.message })
    }
  }
  return NextResponse.json({ success: true, results })
}
