// src/lib/xero/tax-rates-sync.js
// XERO-BILL-VAT.2 — Xero tax-rate cache sync. Mirror of accounts-sync.js.
//
// One-shot pull of /TaxRates into xero_tax_rates. Hit manually from
// Settings (alongside accounts) + on connect. Rates change rarely, so
// no cron — same posture as the chart of accounts.

import { withFreshToken, XeroError } from './client'
import { createServerClient } from '@/lib/supabase'

// Xero returns EffectiveRate as a percentage; if it's missing (older
// orgs / composite rates) sum the TaxComponents rates.
function effectiveRateOf(tr) {
  if (typeof tr.EffectiveRate === 'number') return tr.EffectiveRate
  if (Array.isArray(tr.TaxComponents)) {
    return tr.TaxComponents.reduce((s, c) => s + (Number(c?.Rate) || 0), 0)
  }
  return null
}

/**
 * Pull the location's Xero tax rates and refresh the local cache.
 * @param {string} locationId
 * @returns {Promise<{ syncedCount: number, deletedCount: number, syncedAt: string }>}
 */
export async function pullTaxRates(locationId) {
  if (!locationId) throw new XeroError('pullTaxRates: locationId required.')

  const db = createServerClient()
  const syncStartedAt = new Date().toISOString()

  let xfetch
  try {
    ;({ xfetch } = await withFreshToken(locationId))
  } catch (e) {
    await db.from('xero_connections')
      .update({ tax_rates_sync_error: e.message || 'Unknown error' })
      .eq('location_id', locationId)
    throw e
  }

  let res
  try {
    res = await xfetch('/TaxRates')
  } catch (e) {
    await db.from('xero_connections')
      .update({ tax_rates_sync_error: e.message || 'Xero /TaxRates call failed' })
      .eq('location_id', locationId)
    throw e
  }

  const rates = Array.isArray(res?.TaxRates) ? res.TaxRates : []

  if (rates.length > 0) {
    const rows = rates.map((tr) => ({
      location_id: locationId,
      tax_type: tr.TaxType,
      name: tr.Name || '(unnamed)',
      effective_rate: effectiveRateOf(tr),
      status: tr.Status || null,
      can_apply_to_expenses: typeof tr.CanApplyToExpenses === 'boolean' ? tr.CanApplyToExpenses : null,
      can_apply_to_revenue: typeof tr.CanApplyToRevenue === 'boolean' ? tr.CanApplyToRevenue : null,
      last_synced_at: syncStartedAt,
      updated_at: new Date().toISOString(),
    })).filter((r) => r.tax_type) // a rate with no TaxType is unusable

    const { error: upErr } = await db
      .from('xero_tax_rates')
      .upsert(rows, { onConflict: 'location_id,tax_type' })
    if (upErr) {
      await db.from('xero_connections')
        .update({ tax_rates_sync_error: upErr.message })
        .eq('location_id', locationId)
      throw new XeroError(`Failed to upsert xero_tax_rates: ${upErr.message}`)
    }
  }

  const { error: delErr, count: deletedCount } = await db
    .from('xero_tax_rates')
    .delete({ count: 'exact' })
    .eq('location_id', locationId)
    .lt('last_synced_at', syncStartedAt)
  if (delErr) {
    await db.from('xero_connections')
      .update({ tax_rates_sync_error: delErr.message })
      .eq('location_id', locationId)
    throw new XeroError(`Failed to clean stale xero_tax_rates: ${delErr.message}`)
  }

  await db.from('xero_connections')
    .update({ tax_rates_last_synced_at: new Date().toISOString(), tax_rates_sync_error: null })
    .eq('location_id', locationId)

  return { syncedCount: rates.length, deletedCount: deletedCount || 0, syncedAt: syncStartedAt }
}
