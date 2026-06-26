// SUPPLIER-MEMORY.1 — per-supplier coding memory for the invoice ingest.
//
// The ingest reads every invoice from a clean slate. This layer lets
// it LEARN, in two halves:
//
//   • matchSupplier — resolve an extracted supplier *name* to a
//     cached Xero contact, so the review screen opens with the
//     supplier already picked instead of just pre-typed. Deliberately
//     an exact (case-insensitive) name match: a wrong auto-match is
//     worse than none, and the on-pick path covers near-misses.
//
//   • recordSupplierDefault / getSupplierDefault — remember which
//     Xero account + category a supplier's invoices get coded to and
//     surface it on the next invoice from that supplier.
//
// resolveExtractionDefaults stitches the two together for the extract
// route: a supplier name in, a ready-to-merge extracted_fields patch
// out.
//
// Every function is best-effort by contract — callers wrap them so a
// memory miss never blocks an extraction or an approval.

/**
 * Resolve an extracted supplier name to a cached Xero contact for
 * this location. Returns the contact only on an unambiguous single
 * match; 0 or 2+ matches → null (let the operator pick by hand).
 *
 * @returns {Promise<{ xero_contact_id, name, email } | null>}
 */
export async function matchSupplier(db, locationId, supplierName) {
  const name = (supplierName || '').trim()
  if (!locationId || name.length < 2) return null

  const { data, error } = await db
    .from('xero_contacts')
    .select('xero_contact_id, name, email')
    .eq('location_id', locationId)
    .eq('status', 'ACTIVE')
    .eq('is_supplier', true)
    .ilike('name', name) // no % wildcards → exact, case-insensitive
    .limit(2)

  if (error || !data || data.length !== 1) return null
  return data[0]
}

/**
 * The remembered coding for one supplier at one location, or null if
 * nothing has been stored yet.
 */
export async function getSupplierDefault(db, locationId, xeroContactId) {
  if (!locationId || !xeroContactId) return null

  const { data, error } = await db
    .from('xero_supplier_defaults')
    .select('default_account_code, default_xero_account_id, default_category, use_count, last_used_at')
    .eq('location_id', locationId)
    .eq('xero_contact_id', xeroContactId)
    .maybeSingle()

  if (error) return null
  return data || null
}

/**
 * Remember (or refresh) a supplier's coding after an invoice is
 * approved. Delegates to the upsert_supplier_default RPC which
 * atomically increments use_count and stamps last_used_at.
 * No-op without an xero_account_id — there's nothing worth remembering.
 */
export async function recordSupplierDefault(db, {
  locationId, xeroContactId, supplierName,
  accountCode, xeroAccountId, category,
}) {
  if (!locationId || !xeroContactId || !xeroAccountId) return

  await db.rpc('upsert_supplier_default', {
    p_location_id: locationId,
    p_xero_contact_id: xeroContactId,
    p_supplier_name: supplierName || null,
    p_account_code: accountCode || null,
    p_xero_account_id: xeroAccountId,
    p_category: category || null,
  })
}

/**
 * For the extract route: given a freshly-extracted supplier name,
 * return a patch to merge into extracted_fields. Empty object when
 * there's nothing to pre-fill (no confident supplier match).
 *
 * Shape: { xero_contact_ref?, xero_account_id?, account_code?, category? }
 */
export async function resolveExtractionDefaults(db, locationId, supplierName) {
  const contact = await matchSupplier(db, locationId, supplierName)
  if (!contact) return {}

  const patch = {
    xero_contact_ref: {
      kind: 'existing',
      xero_contact_id: contact.xero_contact_id,
      name: contact.name,
      ...(contact.email ? { email: contact.email } : {}),
    },
  }

  const def = await getSupplierDefault(db, locationId, contact.xero_contact_id)
  if (def) {
    if (def.default_xero_account_id) {
      patch.xero_account_id = def.default_xero_account_id
      patch.account_code = def.default_account_code || null
    }
    if (def.default_category) patch.category = def.default_category
  }

  return patch
}
