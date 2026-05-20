// XERO-API.1 PR 1 — chart-of-accounts cache sync.
//
// One-shot pull of /Accounts into the local xero_accounts cache.
// Hit manually from Settings (no cron, no auto-refresh) because
// the chart of accounts rarely changes — Dext takes the same
// posture and it works fine in practice. If/when the cache drifts,
// the bookkeeper presses Refresh.
//
// Stale-row handling (see mig 186 header):
//   1. Capture syncStartedAt before the API call.
//   2. UPSERT every account, stamping last_synced_at = syncStartedAt.
//   3. DELETE any rows whose last_synced_at is older — those didn't
//      come back from Xero, so they're gone.
//
// Why no /Accounts pagination: Xero returns the entire chart in a
// single response — typical org has 50–200 accounts; large orgs
// might hit a few hundred. There's no `page` param documented for
// /Accounts and the response stays under the default size cap.
// /Contacts is the one that needs the loop; this one doesn't.

import { withFreshToken, XeroError } from './client'
import { createServerClient } from '@/lib/supabase'

/**
 * Pull the location's chart of accounts and refresh the local cache.
 * Returns counts; throws XeroError on transport / DB failure.
 *
 * @param {string} locationId
 * @returns {Promise<{ syncedCount: number, deletedCount: number, syncedAt: string }>}
 */
export async function pullAccounts(locationId) {
  if (!locationId) throw new XeroError('pullAccounts: locationId required.')

  const db = createServerClient()
  const syncStartedAt = new Date().toISOString()

  let xfetch
  try {
    ;({ xfetch } = await withFreshToken(locationId))
  } catch (e) {
    // Persist the error onto the connection row so the UI can
    // surface it next to the Refresh button. Best-effort — if the
    // connection doesn't exist there's nothing to update and we
    // just rethrow.
    await db
      .from('xero_connections')
      .update({ accounts_sync_error: e.message || 'Unknown error' })
      .eq('location_id', locationId)
    throw e
  }

  let res
  try {
    res = await xfetch('/Accounts')
  } catch (e) {
    await db
      .from('xero_connections')
      .update({ accounts_sync_error: e.message || 'Xero /Accounts call failed' })
      .eq('location_id', locationId)
    throw e
  }

  const xeroAccounts = Array.isArray(res?.Accounts) ? res.Accounts : []

  // UPSERT in one batch. Supabase caps per-statement payload but
  // the chart fits comfortably.
  if (xeroAccounts.length > 0) {
    const rows = xeroAccounts.map((a) => ({
      location_id: locationId,
      xero_account_id: a.AccountID,
      code: a.Code || null,
      name: a.Name || '(unnamed)',
      account_type: a.Type || null,
      status: a.Status || null,
      tax_type: a.TaxType || null,
      // Xero returns ShowInExpenseClaims as a boolean string on
      // some org states; coerce to actual boolean.
      show_in_expense_claims: typeof a.ShowInExpenseClaims === 'boolean'
        ? a.ShowInExpenseClaims
        : (a.ShowInExpenseClaims === 'true' ? true
          : a.ShowInExpenseClaims === 'false' ? false : null),
      last_synced_at: syncStartedAt,
      updated_at: new Date().toISOString(),
    }))
    const { error: upErr } = await db
      .from('xero_accounts')
      .upsert(rows, { onConflict: 'location_id,xero_account_id' })
    if (upErr) {
      await db
        .from('xero_connections')
        .update({ accounts_sync_error: upErr.message })
        .eq('location_id', locationId)
      throw new XeroError(`Failed to upsert xero_accounts: ${upErr.message}`)
    }
  }

  // Stale-row sweep. Anything still tagged with a last_synced_at
  // older than this sync's start time wasn't returned by Xero =
  // archived & purged or otherwise no longer in the chart.
  const { error: delErr, count: deletedCount } = await db
    .from('xero_accounts')
    .delete({ count: 'exact' })
    .eq('location_id', locationId)
    .lt('last_synced_at', syncStartedAt)
  if (delErr) {
    await db
      .from('xero_connections')
      .update({ accounts_sync_error: delErr.message })
      .eq('location_id', locationId)
    throw new XeroError(`Failed to clean stale xero_accounts: ${delErr.message}`)
  }

  // Stamp success on the connection row.
  await db
    .from('xero_connections')
    .update({
      accounts_last_synced_at: new Date().toISOString(),
      accounts_sync_error: null,
    })
    .eq('location_id', locationId)

  return {
    syncedCount: xeroAccounts.length,
    deletedCount: deletedCount || 0,
    syncedAt: syncStartedAt,
  }
}
