// XERO-API.1 PR 1 — contacts cache sync.
//
// One-shot pull of /Contacts (paginated) into the local
// xero_contacts cache. Same posture as accounts-sync.js — manual
// refresh from Settings, no cron. Mirrors Dext's behaviour.
//
// Pagination
// ----------
// /Contacts returns up to 100 contacts per page (Xero hard cap;
// the `pageSize` param Xero docs mention is not honoured on every
// endpoint version, and the safest assumption is 100). We loop
// page=1,2,3,… until a page comes back with <100 results = last
// page reached. Cap at 100 pages (10,000 contacts) as a safety
// belt — if a tenant has more, we want to know and add proper
// streaming rather than blow up memory.
//
// includeArchived=true so the cache also catches ARCHIVED rows.
// Archived contacts are hidden from the supplier picker (status
// filter in the picker) but the cache still resolves the label
// when an old extracted_fields row references one.
//
// Stale-row handling is identical to accounts-sync.js.

import { withFreshToken, XeroError } from './client'
import { createServerClient } from '@/lib/supabase'

const XERO_CONTACTS_PER_PAGE = 100
const MAX_PAGES = 100 // safety belt — see header

/**
 * Pull every contact in the location's Xero org and refresh the
 * local cache. Returns counts; throws XeroError on transport / DB
 * failure.
 *
 * @param {string} locationId
 * @returns {Promise<{ syncedCount: number, deletedCount: number, syncedAt: string, pages: number }>}
 */
export async function pullContacts(locationId) {
  if (!locationId) throw new XeroError('pullContacts: locationId required.')

  const db = createServerClient()
  const syncStartedAt = new Date().toISOString()

  let xfetch
  try {
    ;({ xfetch } = await withFreshToken(locationId))
  } catch (e) {
    await db
      .from('xero_connections')
      .update({ contacts_sync_error: e.message || 'Unknown error' })
      .eq('location_id', locationId)
    throw e
  }

  // Page through /Contacts until a partial-page comes back.
  const all = []
  let page = 1
  for (; page <= MAX_PAGES; page++) {
    let res
    try {
      res = await xfetch(`/Contacts?includeArchived=true&page=${page}&order=Name ASC`)
    } catch (e) {
      await db
        .from('xero_connections')
        .update({ contacts_sync_error: e.message || `Xero /Contacts page ${page} failed` })
        .eq('location_id', locationId)
      throw e
    }
    const batch = Array.isArray(res?.Contacts) ? res.Contacts : []
    all.push(...batch)
    if (batch.length < XERO_CONTACTS_PER_PAGE) break
  }
  if (page > MAX_PAGES) {
    const msg = `Xero contact sync stopped at ${MAX_PAGES} pages — tenant has > ${MAX_PAGES * XERO_CONTACTS_PER_PAGE} contacts. Increase MAX_PAGES or switch to streaming.`
    await db
      .from('xero_connections')
      .update({ contacts_sync_error: msg })
      .eq('location_id', locationId)
    throw new XeroError(msg)
  }

  if (all.length > 0) {
    // Chunked upsert — supabase-js has no strict cap but very large
    // single payloads are slower. 500-row chunks keep each round-
    // trip snappy and surface batch-level errors precisely.
    const CHUNK = 500
    const updatedAt = new Date().toISOString()
    for (let i = 0; i < all.length; i += CHUNK) {
      const chunk = all.slice(i, i + CHUNK).map((c) => ({
        location_id: locationId,
        xero_contact_id: c.ContactID,
        name: c.Name || '(unnamed)',
        email: c.EmailAddress || null,
        is_supplier: c.IsSupplier === true,
        is_customer: c.IsCustomer === true,
        status: c.ContactStatus || null,
        default_currency: c.DefaultCurrency || null,
        tax_number: c.TaxNumber || null,
        last_synced_at: syncStartedAt,
        updated_at: updatedAt,
      }))
      const { error: upErr } = await db
        .from('xero_contacts')
        .upsert(chunk, { onConflict: 'location_id,xero_contact_id' })
      if (upErr) {
        await db
          .from('xero_connections')
          .update({ contacts_sync_error: upErr.message })
          .eq('location_id', locationId)
        throw new XeroError(`Failed to upsert xero_contacts: ${upErr.message}`)
      }
    }
  }

  // Stale-row sweep.
  const { error: delErr, count: deletedCount } = await db
    .from('xero_contacts')
    .delete({ count: 'exact' })
    .eq('location_id', locationId)
    .lt('last_synced_at', syncStartedAt)
  if (delErr) {
    await db
      .from('xero_connections')
      .update({ contacts_sync_error: delErr.message })
      .eq('location_id', locationId)
    throw new XeroError(`Failed to clean stale xero_contacts: ${delErr.message}`)
  }

  await db
    .from('xero_connections')
    .update({
      contacts_last_synced_at: new Date().toISOString(),
      contacts_sync_error: null,
    })
    .eq('location_id', locationId)

  return {
    syncedCount: all.length,
    deletedCount: deletedCount || 0,
    syncedAt: syncStartedAt,
    pages: page,
  }
}
