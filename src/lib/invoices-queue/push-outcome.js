// XEROBULK.1 (15 Nov feature audit, October finding A16) — the ONE place a
// queue row's Xero push result is recorded, shared by the single-row
// data-approve route and the bulk send route. The bulk route used to stamp
// every pushed row 'forwarded' without looking at attachmentError, so a bill
// whose source file never attached left the inbox as sent; the single route
// already kept it retryable. Both now go through here.
//
// Also the shared supplier-memory write (SUPPLIER-MEMORY.1): the single route
// remembered a supplier's coding on approval, the bulk route (the one
// bookkeepers use) never did.

import { recordSupplierDefault } from './supplier-defaults.js'

/**
 * Record what a pushQueueRowToXero result means for the row.
 *
 * - attachmentError: the bill exists in Xero but the source file did not
 *   attach. The row stays at 'data_approved' WITH the bill id, so a retry
 *   re-attaches to the same bill instead of creating a duplicate.
 * - otherwise: 'forwarded', compare-and-set on 'data_approved'.
 *
 * @returns {Promise<
 *   | { outcome: 'ok', row: object }
 *   | { outcome: 'attachment_failed', message: string }
 *   | { outcome: 'conflict' }
 *   | { outcome: 'error', message: string }
 * >}
 */
export async function recordPushOutcome(db, id, pushResult, { select = 'id' } = {}) {
  const now = new Date().toISOString()
  const billFields = {
    xero_bill_id: pushResult.billId,
    xero_bill_number: pushResult.billNumber,
    xero_deep_link_url: pushResult.deepLinkUrl,
    xero_synced_at: now,
  }

  if (pushResult.attachmentError) {
    const message = `Bill created in Xero, but attaching the source file failed: ${pushResult.attachmentError}. Click "Retry send to Xero" to attach it.`
    const { error } = await db
      .from('invoices_queue')
      .update({ ...billFields, xero_error: message })
      .eq('id', id)
    if (error) return { outcome: 'error', message: `The bill was created in Xero but the row could not be updated: ${error.message}` }
    return { outcome: 'attachment_failed', message }
  }

  const { data, error } = await db
    .from('invoices_queue')
    .update({ ...billFields, status: 'forwarded', forwarded_at: now, xero_error: null })
    .eq('id', id)
    .eq('status', 'data_approved')
    .select(select)
  if (error) return { outcome: 'error', message: error.message }
  if (!data || data.length === 0) return { outcome: 'conflict' }
  return { outcome: 'ok', row: data[0] }
}

/**
 * SUPPLIER-MEMORY.1 — remember this supplier's coding so the next invoice
 * from them pre-fills. Best-effort: never blocks the approval. Only an
 * existing Xero contact with a picked account is remembered.
 * @returns {Promise<boolean>} true when something was recorded
 */
export async function rememberSupplierCoding(db, row) {
  const ef = row?.extracted_fields || {}
  const ref = ef.xero_contact_ref
  if (!(ref?.kind === 'existing' && ref.xero_contact_id && ef.xero_account_id)) return false
  // Remember a rate only when it is a person's pick or backed by a stated
  // subtotal and tax; a guess (e.g. a till receipt with no VAT breakdown) must
  // never overwrite the supplier's real rate or silence the "VAT differs" check.
  const blank = (v) => v === null || v === undefined || String(v).trim() === ''
  const hasBreakdown = Number(ef.subtotal) > 0 && !blank(ef.tax_amount) && Number.isFinite(Number(ef.tax_amount))
  const hasType = typeof ef.tax_type === 'string' && ef.tax_type.trim() !== ''
  let taxType = null
  if (hasType) {
    const src = ef.tax_type_source
    if (src === 'manual' || src === null || src === undefined) taxType = ef.tax_type
    else if (src === 'derived' && hasBreakdown) taxType = ef.tax_type
  } else if (hasBreakdown && Number(ef.tax_amount) === 0) {
    taxType = 'NONE'
  }
  await recordSupplierDefault(db, {
    locationId: row.location_id,
    xeroContactId: ref.xero_contact_id,
    supplierName: ref.name || ef.supplier_name || null,
    accountCode: ef.account_code || null,
    xeroAccountId: ef.xero_account_id,
    category: ef.category || null,
    taxType,
  })
  return true
}
