// src/app/api/cron/ad-insights-backfill/route.js
// Manual one-time backfill: pull historical insights for every active account.
// Auth: Bearer CRON_SECRET. NOT scheduled (no vercel.json entry, no heartbeat
// row): defineCron owns the secret check and the error boundary, and every
// path answers `stamp: false`, so it never stamps anything. An unreadable
// ad_accounts list answers 500 with a fixed line (it used to answer success
// with no results); one account failing is a result with a fixed line, its
// detail logged and kept on ad_accounts.last_sync_error.
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

export const GET = defineCron({ heartbeat: 'ad-insights-backfill' }, async ({ db, request }) => {
  const url = new URL(request.url)
  const sinceParam = url.searchParams.get('since')
  const untilParam = url.searchParams.get('until')
  const nowMs = Date.now()
  // TZ.11c: the default window is 30 days in EACH account's own zone (Meta
  // dates insights in the ad account's timezone); explicit params apply as given.
  const { data: accounts, error: accountsErr } = await db.from('ad_accounts').select('*, locations(id, timezone)').eq('is_active', true)
  if (accountsErr) {
    logError('cron-ad-insights-backfill', 'ad_accounts read failed; nothing backfilled', { err: accountsErr })
    return { ok: false, body: { error: 'Could not read ad accounts' } }
  }
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
      logWarn('cron-ad-insights-backfill', 'account backfill failed', { accountId: account.id, err: e?.message })
      await db.from('ad_accounts').update({ last_sync_error: e.message }).eq('id', account.id)
      results.push({ id: account.id, error: 'backfill failed' })
    }
  }
  return { stamp: false, body: { results } }
})
