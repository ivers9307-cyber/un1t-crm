// src/app/api/cron/ad-insights-sync/route.js
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { syncAccount } from '@/lib/ads/sync'
import * as meta from '@/lib/ads/providers/meta'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const PROVIDERS = { meta }
const BREAKDOWNS = ['publisher_platform', 'age', 'gender']

function dublinDateStr(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000)
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Dublin' }).format(d) // YYYY-MM-DD
}

export async function GET(request) {
  const auth = request.headers.get('authorization') || ''
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  }
  const db = createServerClient()
  // yesterday+today: this cron runs every 4h so today stays live, and yesterday
  // gets its final full total after the day rolls over (a today-only window would
  // permanently miss each day's last few hours). Upsert makes the re-pull idempotent.
  const since = dublinDateStr(-1), until = dublinDateStr(0)
  const { data: accounts } = await db.from('ad_accounts').select('*').eq('is_active', true)
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
  await stampHeartbeat('ad-insights-sync').catch(() => {})
  return NextResponse.json({ success: true, results })
}
