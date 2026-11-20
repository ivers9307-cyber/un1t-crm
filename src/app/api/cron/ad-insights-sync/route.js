// src/app/api/cron/ad-insights-sync/route.js
//
// defineCron owns the CRON_SECRET check, the error boundary and the heartbeat.
// Every run stamps 'ad-insights-sync' except one whose ad_accounts read failed
// (500, fixed line). One account failing at Meta is a result with a fixed
// line, its detail logged and kept on ad_accounts.last_sync_error; the row
// watches the cron, not Meta.
import { defineCron } from '@/lib/define-cron'
import { syncAccount } from '@/lib/ads/sync'
import * as meta from '@/lib/ads/providers/meta'
import { adAccountDay } from '@/lib/ads/account-day'
import { logError, logWarn } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const PROVIDERS = { meta }
const BREAKDOWNS = ['publisher_platform', 'age', 'gender']

export const GET = defineCron({ heartbeat: 'ad-insights-sync' }, async ({ db }) => {
  // yesterday+today: this cron runs every 4h so today stays live, and yesterday
  // gets its final full total after the day rolls over (a today-only window would
  // permanently miss each day's last few hours). Upsert makes the re-pull idempotent.
  // TZ.11c: "yesterday" and "today" are days in EACH account's own zone (Meta
  // dates insights in the ad account's timezone), so the window is per account;
  // the embedded location zone is the fallback (account-day.js).
  const nowMs = Date.now()
  const { data: accounts, error: accountsErr } = await db.from('ad_accounts').select('*, locations(id, timezone)').eq('is_active', true)
  if (accountsErr) {
    // CRONREADERR.1 — a failed read is not "no accounts". Nothing is synced and
    // the heartbeat is NOT stamped: the next 4-hourly run re-pulls yesterday +
    // today, so one missed run loses no data, and the row's grace (mig 644:
    // 14400 + 18000) absorbs one missed stamp. A read broken on every run pages.
    logError('cron-ad-insights-sync', 'ad_accounts read failed; nothing synced, heartbeat not stamped', { err: accountsErr })
    return { ok: false, body: { error: 'Could not read ad accounts' } }
  }
  const results = []
  for (const account of accounts || []) {
    try {
      const provider = PROVIDERS[account.provider]
      if (!provider) { results.push({ id: account.id, skipped: 'no_provider' }); continue }
      const since = adAccountDay(account, { nowMs, offsetDays: -1 }), until = adAccountDay(account, { nowMs })
      await syncAccount(db, account, provider, { since, until, breakdowns: account.provider === 'meta' ? BREAKDOWNS : [] })
      // Bookkeeping only: the insights are already upserted, so a failed label
      // write leaves a stale "last synced", never lost data.
      const { error: syncedErr } = await db.from('ad_accounts').update({ last_synced_at: new Date().toISOString(), last_sync_error: null }).eq('id', account.id)
      if (syncedErr) logWarn('cron-ad-insights-sync', 'could not record the account sync time', { accountId: account.id, err: syncedErr })
      results.push({ id: account.id, ok: true })
    } catch (e) {
      logWarn('cron-ad-insights-sync', 'account sync failed', { accountId: account.id, err: e?.message })
      // This write is the only record of WHY the account failed; if it fails,
      // the log carries the reason instead.
      const { error: recordErr } = await db.from('ad_accounts').update({ last_sync_error: e.message }).eq('id', account.id)
      if (recordErr) logError('cron-ad-insights-sync', 'could not record the account sync error', { accountId: account.id, syncError: e.message, err: recordErr })
      results.push({ id: account.id, error: 'sync failed' })
    }
  }
  return { body: { results } }
})
