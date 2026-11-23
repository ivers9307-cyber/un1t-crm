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

import { escapeLikePattern } from '../like-escape'
import { logWarn } from '@/lib/log'

// SUPPLIERMATCH.1 — three ways to recognise a supplier, tried in order. Each
// answers only when exactly one contact fits; anything else is "no match" and a
// person picks. A wrong match would post a bill to the wrong supplier, so no
// rule here guesses: no prefixes, no partial words, no nearest name.
//
//   1. The read name equals a Xero supplier's name (case-insensitive).
//   2. History: every bill this studio approved or sent under the same tidied
//      name went to one contact. A person chose that contact, so it is the
//      strongest evidence there is for a name Xero spells differently.
//   3. The tidied read name equals one Xero supplier's tidied name ("X Ltd."
//      and "X Limited" are the same supplier).

// Legal-form words dropped from the END of a name only.
const LEGAL_SUFFIXES = new Set([
  'ltd', 'limited', 'plc', 'llc', 'llp', 'inc', 'dac', 'uc', 'clg', 'gmbh', 'teoranta', 'teo',
  'sl', 'sa', 'bv', 'nv', 'kft', 'lda', 'srl', 'sas', 'ag', 'ab', 'oy', 'company',
])
const HISTORY_STATUSES = ['data_approved', 'forwarded']
const HISTORY_LIMIT = 500
const CONTACT_PAGE = 1000
const CONTACT_PAGES = 5

/**
 * A supplier name reduced to what identifies it: lower case, no accents, no
 * bracketed aside, no "c/o" or "t/a" tail, no punctuation, no trailing legal
 * form, no leading "the". Returns '' when nothing usable is left.
 *
 * @param {unknown} name
 * @returns {string}
 */
export function tidySupplierName(name) {
  let s = String(name ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  s = s.replace(/\([^)]*\)/g, ' ')
  s = s.replace(/\s(c\/o|t\/a|trading as)\s.*$/, ' ')
  // "S.L." and "B.V." are one word each, so dots go before other punctuation.
  s = s.replace(/\./g, '').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim()
  const words = s.split(' ').filter(Boolean)
  while (words.length > 1 && LEGAL_SUFFIXES.has(words[words.length - 1])) words.pop()
  if (words.length > 1 && words[0] === 'the') words.shift()
  const key = words.join(' ')
  return key.length >= 2 ? key : ''
}

/** Lower case, no accents, punctuation to spaces: every word kept, in order. */
function plainWords(name) {
  return String(name ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/\./g, '').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim()
}

/**
 * Does the name read off a document agree with a Xero contact's name? True
 * when they tidy to the same name, or when the contact's tidied name (at least
 * five characters) appears as whole words inside the document's name. This is
 * supporting evidence only, for a contact something else already points at (a
 * bill found in Xero by its number); it is never used to search for a supplier.
 *
 * @param {unknown} readName
 * @param {unknown} contactName
 */
export function supplierNamesAgree(readName, contactName) {
  const contactKey = tidySupplierName(contactName)
  if (!contactKey) return false
  if (tidySupplierName(readName) === contactKey) return true
  if (contactKey.length < 5) return false
  return ` ${plainWords(readName)} `.includes(` ${contactKey} `)
}

/**
 * The contact a bill found in Xero names, if it can be trusted for this
 * document: an active contact of this studio whose name agrees with the name
 * read off the document. An invoice number alone is not enough, because two
 * suppliers can use the same number.
 *
 * @param {any} db
 * @param {string} locationId
 * @param {unknown} readName
 * @param {{ ContactID?: string, Name?: string }|null|undefined} billContact
 * @returns {Promise<{ xero_contact_id: string, name: string, email: string|null } | null>}
 */
export async function contactFromXeroBill(db, locationId, readName, billContact) {
  const id = billContact?.ContactID
  if (!locationId || !id) return null
  const { data, error } = await db
    .from('xero_contacts')
    .select('xero_contact_id, name, email')
    .eq('location_id', locationId)
    .eq('status', 'ACTIVE')
    .eq('xero_contact_id', String(id))
    .limit(2)
  if (error || !data || data.length !== 1) return null
  return supplierNamesAgree(readName, data[0].name) ? data[0] : null
}

async function matchExact(db, locationId, name) {
  const { data, error } = await db
    .from('xero_contacts')
    .select('xero_contact_id, name, email')
    .eq('location_id', locationId)
    .eq('status', 'ACTIVE')
    .eq('is_supplier', true)
    // Escaped, so this really is an exact case-insensitive match. The pattern
    // is an OCR/AI-extracted supplier name off a PDF a third party sent us, and
    // an unescaped `_` silently matched a DIFFERENT supplier, which .limit(2)'s
    // ambiguity guard cannot see (one wrong row is still one row). See
    // src/lib/like-escape.js.
    .ilike('name', escapeLikePattern(name))
    .limit(2)

  if (error || !data || data.length !== 1) return null
  return data[0]
}

/** The one contact every earlier bill under this tidied name went to, if it is still an active Xero contact. */
async function matchByHistory(db, locationId, key) {
  const { data, error } = await db
    .from('invoices_queue')
    .select('extracted_fields')
    .eq('location_id', locationId)
    .in('status', HISTORY_STATUSES)
    .order('received_at', { ascending: false })
    .limit(HISTORY_LIMIT)
  if (error || !Array.isArray(data)) return null

  const ids = new Set()
  for (const row of data) {
    const f = row?.extracted_fields
    const id = f?.xero_contact_ref?.xero_contact_id
    if (!id || tidySupplierName(f?.supplier_name) !== key) continue
    ids.add(String(id))
  }
  if (ids.size !== 1) return null

  const { data: contacts, error: contactErr } = await db
    .from('xero_contacts')
    .select('xero_contact_id, name, email')
    .eq('location_id', locationId)
    .eq('status', 'ACTIVE')
    .eq('xero_contact_id', [...ids][0])
    .limit(2)
  if (contactErr || !contacts || contacts.length !== 1) return null
  return contacts[0]
}

/** The one active Xero supplier whose tidied name equals this one. */
async function matchTidied(db, locationId, key) {
  const hits = []
  for (let page = 0; page < CONTACT_PAGES; page++) {
    const { data, error } = await db
      .from('xero_contacts')
      .select('xero_contact_id, name, email')
      .eq('location_id', locationId)
      .eq('status', 'ACTIVE')
      .eq('is_supplier', true)
      .order('xero_contact_id', { ascending: true })
      .range(page * CONTACT_PAGE, (page + 1) * CONTACT_PAGE - 1)
    if (error || !Array.isArray(data)) return null
    for (const c of data) if (tidySupplierName(c.name) === key) hits.push(c)
    if (hits.length > 1) return null
    if (data.length < CONTACT_PAGE) break
  }
  return hits.length === 1 ? hits[0] : null
}

/**
 * Resolve an extracted supplier name to a cached Xero contact for this
 * location. Returns the contact only when one of the three rules above gives
 * exactly one; otherwise null (let the operator pick by hand). Never throws.
 *
 * @returns {Promise<{ xero_contact_id, name, email } | null>}
 */
export async function matchSupplier(db, locationId, supplierName) {
  const name = (supplierName || '').trim()
  if (!locationId || name.length < 2) return null

  const exact = await matchExact(db, locationId, name)
  if (exact) return exact

  const key = tidySupplierName(name)
  if (!key) return null
  try {
    return (await matchByHistory(db, locationId, key)) || (await matchTidied(db, locationId, key))
  } catch (e) {
    logWarn('supplier-defaults', 'supplier match failed', { location_id: locationId, error: e?.message })
    return null
  }
}

/**
 * The patch a known contact brings to extracted_fields: the supplier itself
 * plus the account and category remembered for it.
 *
 * @param {any} db
 * @param {string} locationId
 * @param {{ xero_contact_id: string, name?: string|null, email?: string|null }} contact
 */
export async function defaultsForContact(db, locationId, contact) {
  const patch = {
    xero_contact_ref: {
      kind: 'existing',
      xero_contact_id: contact.xero_contact_id,
      name: contact.name,
      ...(contact.email ? { email: contact.email } : {}),
    },
  }

  // The remembered tax type is deliberately NOT patched in: a rate derived from
  // the document's own figures must win; the remembered one is only compared later.
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

/**
 * The remembered coding for one supplier at one location, or null if
 * nothing has been stored yet.
 */
export async function getSupplierDefault(db, locationId, xeroContactId) {
  if (!locationId || !xeroContactId) return null

  const { data, error } = await db
    .from('xero_supplier_defaults')
    .select('default_account_code, default_xero_account_id, default_category, default_tax_type, use_count, last_used_at')
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
  accountCode, xeroAccountId, category, taxType,
}) {
  if (!locationId || !xeroContactId || !xeroAccountId) return

  // Best-effort: a memory write must never fail an approval, so log and move on.
  let error = null
  try {
    ;({ error } = await db.rpc('upsert_supplier_default', {
    p_location_id: locationId,
    p_xero_contact_id: xeroContactId,
    p_supplier_name: supplierName || null,
    p_account_code: accountCode || null,
    p_xero_account_id: xeroAccountId,
    p_category: category || null,
    // null leaves the stored rate unchanged (see the RPC).
    p_tax_type: taxType || null,
    }))
  } catch (e) {
    error = e
  }
  if (error) {
    logWarn('supplier-defaults', 'could not remember supplier coding', {
      location_id: locationId, xero_contact_id: xeroContactId, error: error.message,
    })
  }
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
  return defaultsForContact(db, locationId, contact)
}
