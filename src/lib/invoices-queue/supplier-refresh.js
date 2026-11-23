// @ts-check
// SUPPLIERMATCH.1 — keep supplier matching current without a paid read.
//
// Two jobs, both run by the invoice sweeper (process-invoice-analysis):
//
//   refreshStaleSupplierList  The CRM's copy of a studio's Xero contacts was
//     only refreshed by hand, and went months stale. Once a day per connected
//     studio it is pulled again. One studio per call, claimed by a
//     compare-and-set on contacts_last_synced_at: two overlapping pulls would
//     each sweep the other's rows as stale and empty the list.
//
//   rematchUnmatchedSuppliers  A row flagged "New supplier" is looked at again
//     when something that could match it has changed since it was last
//     checked: the studio's contact list was refreshed, or the studio sent a
//     bill to Xero (a person picked a supplier, which teaches the name). The
//     row's prepared_at is re-stamped, so each change costs one look per row.
//     Rows that were never prepared on arrival (prepared_at null) are left
//     alone.
//
// Neither reads a file, calls the reader or sends anything to Xero.

import { logWarn } from '@/lib/log'
import { pullContacts } from '@/lib/xero/contacts-sync'
import { recheckInvoiceRow } from '@/lib/invoices-queue/prepare'

const MODULE = 'supplier-refresh'
export const SUPPLIER_LIST_MAX_AGE_MS = 24 * 60 * 60 * 1000
export const REMATCH_LIMIT = 25

/** @param {any} e */
const messageOf = (e) => (e instanceof Error ? e.message : String(e))

/**
 * Refresh the Xero contact list of at most one connected studio whose copy is
 * older than a day. Never throws.
 *
 * @param {import('@/lib/supabase').Db} db  service-role client
 * @param {{ now?: () => Date, pull?: (locationId: string) => Promise<any> }} [deps]
 * @returns {Promise<{ refreshed: string|null }>} the studio refreshed, if any
 */
export async function refreshStaleSupplierList(db, deps = {}) {
  try {
    const now = (deps.now || (() => new Date()))()
    const cutoff = now.getTime() - SUPPLIER_LIST_MAX_AGE_MS
    const { data, error } = await db
      .from('xero_connections')
      .select('location_id, contacts_last_synced_at')
      .order('location_id', { ascending: true })
    if (error || !Array.isArray(data)) return { refreshed: null }

    const stale = data
      .filter((c) => c.location_id && (!c.contacts_last_synced_at || Date.parse(c.contacts_last_synced_at) < cutoff))
      // Never-synced first, then the oldest.
      .sort((a, b) => (Date.parse(a.contacts_last_synced_at || '') || 0) - (Date.parse(b.contacts_last_synced_at || '') || 0))
    const target = stale[0]
    if (!target) return { refreshed: null }

    // Claim: only the tick that moves the stamp off the value it read pulls.
    let claim = db
      .from('xero_connections')
      .update({ contacts_last_synced_at: now.toISOString() })
      .eq('location_id', target.location_id)
    claim = target.contacts_last_synced_at
      ? claim.eq('contacts_last_synced_at', target.contacts_last_synced_at)
      : claim.is('contacts_last_synced_at', null)
    const { data: claimed, error: claimErr } = await claim.select('location_id')
    if (claimErr || !Array.isArray(claimed) || claimed.length === 0) return { refreshed: null }

    try {
      await (deps.pull || pullContacts)(target.location_id)
      return { refreshed: target.location_id }
    } catch (e) {
      // The stamp stays, so a broken connection is tried once a day, not every tick.
      logWarn(MODULE, 'could not refresh the Xero contact list', { location_id: target.location_id, error: messageOf(e) })
      return { refreshed: null }
    }
  } catch (e) {
    logWarn(MODULE, 'supplier list refresh failed', { error: messageOf(e) })
    return { refreshed: null }
  }
}

/**
 * Look again for the supplier of rows flagged "New supplier", where the
 * studio's contact list or its sent bills changed since the row was checked.
 * Never throws.
 *
 * @param {import('@/lib/supabase').Db} db  service-role client
 * @param {{ limit?: number }} [opts]
 * @returns {Promise<{ checked: number, matched: number }>}
 */
export async function rematchUnmatchedSuppliers(db, opts = {}) {
  const limit = opts.limit ?? REMATCH_LIMIT
  let checked = 0
  let matched = 0
  try {
    const { data: connections, error } = await db
      .from('xero_connections')
      .select('location_id, contacts_last_synced_at')
      .order('location_id', { ascending: true })
    if (error || !Array.isArray(connections)) return { checked, matched }

    for (const c of connections) {
      if (checked >= limit || !c.location_id) continue

      const { data: lastSent } = await db
        .from('invoices_queue')
        .select('forwarded_at')
        .eq('location_id', c.location_id)
        .eq('status', 'forwarded')
        .not('forwarded_at', 'is', null)
        .order('forwarded_at', { ascending: false })
        .limit(1)
      const changedAt = [c.contacts_last_synced_at, lastSent?.[0]?.forwarded_at]
        .filter((t) => typeof t === 'string')
        .map(String)
        .sort((a, b) => Date.parse(b) - Date.parse(a))[0]
      if (!changedAt) continue

      const { data: rows, error: rowsErr } = await db
        .from('invoices_queue')
        .select('*')
        .eq('location_id', c.location_id)
        .eq('status', 'extracted')
        .contains('review_reasons', ['new_supplier'])
        .lt('prepared_at', changedAt)
        .order('prepared_at', { ascending: true })
        .limit(limit - checked)
      if (rowsErr || !Array.isArray(rows)) continue

      for (const row of rows) {
        const { reasons } = await recheckInvoiceRow(db, row, { rematchSupplier: true })
        checked++
        if (!reasons.includes('new_supplier')) matched++
      }
    }
  } catch (e) {
    logWarn(MODULE, 'supplier rematch failed', { error: messageOf(e) })
  }
  return { checked, matched }
}
