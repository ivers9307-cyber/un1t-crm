// src/app/api/cron/ad-insights-sync/route.js
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { syncAccount } from '@/lib/ads/sync'
import * as meta from '@/lib/ads/providers/meta'
import { logError, logWarn } from '@/lib/log'

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
  const { data: accounts, error: accountsErr } = await db.from('ad_accounts').select('*').eq('is_active', true)
  if (accountsErr) {
    // CRONREADERR.1 — a failed read is not "no accounts". Nothing is synced and
    // the heartbeat is NOT stamped: the next 4-hourly run re-pulls yesterday +
    // today, so one missed run loses no data, and the row's grace (mig 644:
    // 14400 + 18000) absorbs one missed stamp. A read broken on every run pages.
    logError('cron-ad-insights-sync', 'ad_accounts read failed; nothing synced, heartbeat not stamped', { err: accountsErr })
    return NextResponse.json({ success: false, error: 'Could not read ad accounts' }, { status: 500 })
  }
  const results = []
  for (const account of accounts || []) {
    try {
      const provider = PROVIDERS[account.provider]
      if (!provider) { results.push({ id: account.id, skipped: 'no_provider' }); continue }
      await syncAccount(db, account, provider, { since, until, breakdowns: account.provider === 'meta' ? BREAKDOWNS : [] })
      // Bookkeeping only: the insights are already upserted, so a failed label
      // write leaves a stale "last synced", never lost data.
      const { error: syncedErr } = await db.from('ad_accounts').update({ last_synced_at: new Date().toISOString(), last_sync_error: null }).eq('id', account.id)
      if (syncedErr) logWarn('cron-ad-insights-sync', 'could not record the account sync time', { accountId: account.id, err: syncedErr })
      results.push({ id: account.id, ok: true })
    } catch (e) {
      // This write is the only record of WHY the account failed; if it fails,
      // the log carries the reason instead.
      const { error: recordErr } = await db.from('ad_accounts').update({ last_sync_error: e.message }).eq('id', account.id)
      if (recordErr) logError('cron-ad-insights-sync', 'could not record the account sync error', { accountId: account.id, syncError: e.message, err: recordErr })
      results.push({ id: account.id, error: e.message })
    }
  }
  await stampHeartbeat('ad-insights-sync').catch(() => {})
  return NextResponse.json({ success: true, results })
}
