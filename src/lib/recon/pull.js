// src/lib/recon/pull.js
//
// RCOV.P0 — one coverage pull for one location: claim the run
// (atomic — see recon_runs_one_running_per_location_idx), list active
// BANK accounts, fetch each account's transactions for the window,
// sync the unreconciled ones into recon_bank_lines, audit in
// recon_runs. Window = oldest non-terminal tracked line, else 90 days.
//
// DATA SOURCE (hotfix 2026-07-04): GET /BankTransactions (paginated,
// status-filtered server-side, IsReconciled filtered CLIENT-side) —
// see bank-transactions.js for why the Bank Statement report had to
// go (retired scope broke the authorize step) and what this source
// cannot see (unactioned statement lines).
//
// GUARDS (both review-mandated):
// - Zero-rows anomaly: an account with tracked non-terminal lines can
//   never legitimately fetch zero transactions for a window that
//   encloses those lines (reconciled ones are still returned — the
//   IsReconciled filter is client-side precisely to preserve this
//   tripwire). Zero rows = fetch/shape drift; syncing would
//   mass-cover. Skip the account, record the anomaly, run → 'error'.
// - Atomic claim: sweep stale 'running' rows (crashed runs), then
//   insert-first; a 23505 unique violation means another run holds
//   the claim. A wedged claim (insert applied but the call failed
//   before returning the id) self-heals via the same 15-min sweep.
import { withFreshToken } from '@/lib/xero/client'
import { mapBankTransactions, bankTransactionLines } from './bank-transactions'
import { syncBankLines } from './coverage'
import { dublinTodayStr, addDaysISO } from '@/lib/dublin-time'

const DEFAULT_WINDOW_DAYS = 90
const STALE_RUN_MS = 15 * 60 * 1000
const NON_TERMINAL = ['uncovered', 'submitted', 'not_found', 'needs_attention']
const MAX_TXN_PAGES = 20 // × 100/page — far beyond expected weekly volume

async function claimRun(db, locationId, trigger) {
  const { error: sweepErr } = await db
    .from('recon_runs')
    .update({
      status: 'error',
      error: 'stale running row — presumed crashed',
      finished_at: new Date().toISOString(),
    })
    .eq('location_id', locationId)
    .eq('status', 'running')
    .lt('started_at', new Date(Date.now() - STALE_RUN_MS).toISOString())
  if (sweepErr) throw new Error(`recon run sweep failed: ${sweepErr.message}`)

  const { data, error } = await db
    .from('recon_runs')
    .insert({ trigger, location_id: locationId })
    .select('id')
    .single()
  if (error) {
    if (error.code === '23505') {
      // .code is the machine contract (cf. XeroError.code in
      // @/lib/xero/client) — consumers branch on it, never on the prose.
      throw Object.assign(
        new Error('A coverage pull for this location is already running'),
        { code: 'recon_pull_running' }
      )
    }
    throw new Error(`recon run claim failed: ${error.message}`)
  }
  return data.id
}

async function windowFromFor(db, locationId) {
  const { data } = await db
    .from('recon_bank_lines')
    .select('line_date')
    .eq('location_id', locationId)
    .in('status', NON_TERMINAL)
    .order('line_date', { ascending: true })
    .limit(1)
    .maybeSingle()
  const floor = addDaysISO(dublinTodayStr(), -DEFAULT_WINDOW_DAYS)
  if (data?.line_date && data.line_date < floor) return data.line_date
  return floor
}

async function hasTrackedLines(db, locationId, bankAccountId) {
  const { data } = await db
    .from('recon_bank_lines')
    .select('id')
    .eq('location_id', locationId)
    .eq('xero_bank_account_id', bankAccountId)
    .in('status', NON_TERMINAL)
    .limit(1)
    .maybeSingle()
  return !!data
}

export async function runCoveragePull(db, locationId, { trigger, acceptMassCover }) {
  const runId = await claimRun(db, locationId, trigger)
  // Hoisted above the try so the catch's audit can persist whatever
  // per-account progress was made before a mid-pull throw.
  const perAccount = []
  const anomalies = []
  try {
    const { xfetch } = await withFreshToken(locationId)
    const windowFrom = await windowFromFor(db, locationId)
    // NOTE: correctness assumes Xero's toDate is INCLUSIVE and the org
    // timezone is Dublin (dublinTodayStr) — if a non-Dublin org ever
    // connects, its same-day lines could fall outside "today" and drop.
    const windowTo = dublinTodayStr()

    const accountsRes = await xfetch('/Accounts?where=' + encodeURIComponent('Type=="BANK"'))
    const accounts = (accountsRes?.Accounts || []).filter((a) => a.Status === 'ACTIVE')

    for (const acct of accounts) {
      // Paginated /BankTransactions fetch: Xero pages at 100. Filters
      // pushed server-side: account, window, AUTHORISED. IsReconciled
      // is deliberately filtered CLIENT-side (header: the zero-rows
      // tripwire needs reconciled rows in the fetch).
      const [fy, fm, fd] = windowFrom.split('-').map(Number)
      const [ty, tm, td] = windowTo.split('-').map(Number)
      const where = encodeURIComponent(
        `BankAccount.AccountID==Guid("${acct.AccountID}") AND Status=="AUTHORISED" AND Date>=DateTime(${fy},${fm},${fd}) AND Date<=DateTime(${ty},${tm},${td})`
      )
      const rows = []
      for (let page = 1; page <= MAX_TXN_PAGES; page += 1) {
        const res = await xfetch(`/BankTransactions?where=${where}&order=Date&page=${page}`)
        rows.push(...mapBankTransactions(res))
        // Break on a short RAW page (the mapper drops rows, so its
        // output length can't be the pagination signal).
        const rawCount = Array.isArray(res?.BankTransactions) ? res.BankTransactions.length : 0
        if (rawCount < 100) break
        if (page === MAX_TXN_PAGES) {
          // Loud, not silent: a 2,000-txn window is beyond any expected
          // volume — if this fires, widen MAX_TXN_PAGES deliberately.
          console.error(`[recon pull] ${acct.AccountID}: hit MAX_TXN_PAGES — window truncated`)
        }
      }
      // Zero-rows anomaly guard. The && ordering is load-bearing: the
      // cheap rows-length check short-circuits BEFORE hasTrackedLines,
      // so the extra DB read (and its positional test mock) only
      // happens for a zero-rows fetch.
      if (rows.length === 0 && (await hasTrackedLines(db, locationId, acct.AccountID))) {
        anomalies.push({
          bankAccountId: acct.AccountID,
          bankAccountName: acct.Name,
          skipped: 'zero_rows_anomaly',
        })
        continue
      }
      const lines = bankTransactionLines(rows)
      const stats = await syncBankLines(db, {
        locationId,
        bankAccountId: acct.AccountID,
        bankAccountName: acct.Name,
        windowFrom,
        windowTo,
        lines,
        acceptMassCover,
      })
      perAccount.push({ bankAccountId: acct.AccountID, bankAccountName: acct.Name, ...stats })
    }

    // forced audits the cover-guard bypass — a mass-cover in the ledger
    // must be traceable to the operator's force, from recon_runs alone.
    const summary = { runId, locationId, windowFrom, windowTo, forced: !!acceptMassCover, accounts: perAccount, anomalies }
    const finish = {
      finished_at: new Date().toISOString(),
      status: anomalies.length > 0 ? 'error' : 'ok',
      stats: summary,
    }
    if (anomalies.length > 0) {
      finish.error = `zero-rows anomaly on ${anomalies.length} account(s) — sync skipped for those accounts`
    }
    await db.from('recon_runs').update(finish).eq('id', runId)
    return summary
  } catch (e) {
    try {
      await db
        .from('recon_runs')
        .update({
          finished_at: new Date().toISOString(),
          status: 'error',
          error: String(e?.message || e),
          // Keep whatever progress was made before the throw — accounts
          // already synced stay diagnosable from the audit row alone.
          stats: { runId, locationId, forced: !!acceptMassCover, accounts: perAccount, anomalies, failedAfter: perAccount.length },
        })
        .eq('id', runId)
    } catch {
      // never mask the original failure with a bookkeeping failure
    }
    throw e
  }
}
