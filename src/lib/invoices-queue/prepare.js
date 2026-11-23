// @ts-check
// INVOICEPREP.3 — read, check and code one invoices_queue row in one place.
//
// prepareInvoiceRow takes a row the caller has already claimed and leaves it
// in a state a person can see: extracted (with review_reasons saying why it
// needs a look, or none when it is ready), not_invoice, or still received /
// quality_approved with an unreadable or duplicate_file reason. Every write
// clears the queue columns, so a row is never left queued and claimed with
// nothing to show for it.
//
// Every write is guarded on the status still being received or
// quality_approved: a row a person moved on while it was being read is left
// alone (outcome 'skipped').
//
// It never sends anything to Xero and never rejects a row. The only Xero call
// is the read-only bill lookup, tried once; any failure there is logged and
// raises nothing.
//
// recheckInvoiceRow recomputes the reasons (and the duplicate link) after a
// person edits an extracted row's fields, without downloading or reading the
// file again.

import { extractInvoiceFieldsFromBytes, scoreExtractionConfidence } from '@/lib/invoice-extraction'
import { sha256Hex } from '@/lib/inbound-invoices'
import { fieldReasons, mergeReasons } from '@/lib/invoices-queue/readiness'
import { resolveBillTaxType } from '@/lib/invoices-queue/vat'
import { contactFromXeroBill, defaultsForContact, resolveExtractionDefaults, getSupplierDefault } from '@/lib/invoices-queue/supplier-defaults'
import { findXeroBillByNumber } from '@/lib/invoices-queue/push-xero'
import { withFreshToken } from '@/lib/xero/client'
import { logWarn, logError } from '@/lib/log'

const MODULE = 'invoices-queue/prepare'

// The type checker here has no Node typings; Buffer is a global at runtime.
const NodeBuffer = /** @type {any} */ (globalThis).Buffer

const PREPARABLE = ['received', 'quality_approved']
// A row in these states was set aside, so a copy of it is not a duplicate.
const NOT_COUNTED_FOR_FILE = new Set(['rejected', 'not_invoice'])
const NUMBER_DUPLICATE_STATUSES = ['extracted', 'data_approved', 'forwarded']
const NOT_INVOICE_TYPES = new Set(['statement', 'other'])
// Reasons only prepareInvoiceRow can establish; a recheck keeps them as they are.
const CARRIED_ON_RECHECK = new Set(['already_in_xero', 'duplicate_file'])
// A select returns at most 1,000 rows; the most recent 500 candidates are plenty.
const CANDIDATE_LIMIT = 500
// The Xero lookup is advisory: a hanging Xero must not hold the worker past
// this, or the row is killed after its paid read and read again by the sweep.
export const XERO_LOOKUP_TIMEOUT_MS = 10_000

/**
 * @typedef {{ findBill: (locationId: string, invoiceNumber: string) => Promise<any> }} XeroLookup
 * @typedef {{
 *   extract?: (bytes: any, mime: string|null, meta: { locationId: string }) => Promise<{ ok: boolean, fields?: any, error?: string }>,
 *   xero?: XeroLookup,
 *   force?: boolean,
 *   now?: () => Date,
 *   xeroTimeoutMs?: number,
 * }} PrepareDeps
 * @typedef {'prepared'|'not_invoice'|'duplicate'|'unreadable'|'skipped'} PrepareOutcome
 * @typedef {{ outcome: PrepareOutcome, reasons: string[] }} PrepareResult
 */

/** @type {XeroLookup} */
const defaultXero = {
  async findBill(locationId, invoiceNumber) {
    const { xfetch } = await withFreshToken(locationId)
    return findXeroBillByNumber(xfetch, invoiceNumber)
  },
}

/**
 * Race a promise against a timer that rejects; the timer is always cleared.
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @returns {Promise<T>}
 */
async function withTimeout(promise, ms) {
  /** @type {any} */
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms)
  })
  try {
    return await Promise.race([promise, /** @type {Promise<never>} */ (timeout)])
  } finally {
    clearTimeout(timer)
  }
}

// INVHARDEN.1 — how many times the queue tries a file before calling it unreadable.
export const MAX_READ_ATTEMPTS = 3
const RETRY_NOTE = /^The reader was unavailable \(attempt (\d+) of \d+\)/

/**
 * A failure of the reader service itself (a timeout, a dropped connection,
 * rate limiting, a 5xx), as opposed to something wrong with the file.
 * @param {unknown} message
 */
export function isTransientReadError(message) {
  const m = String(message ?? '')
  return /timed out/i.test(m)
    || /^Anthropic API request failed/i.test(m)
    || /^Anthropic API error \((408|409|425|429|5\d\d)\)/i.test(m)
    || /overloaded/i.test(m)
}

/** How many attempts the row's stored error records (0 when it records none). @param {unknown} stored */
export function readAttemptOf(stored) {
  const m = RETRY_NOTE.exec(String(stored ?? ''))
  return m ? Number(m[1]) : 0
}

/** @param {number} attempt @param {unknown} message */
function retryNote(attempt, message) {
  return `The reader was unavailable (attempt ${attempt} of ${MAX_READ_ATTEMPTS}). It will be read again shortly. ${String(message ?? '').slice(0, 300)}`
}

/** @param {any} v */
const blank = (v) => v == null || (typeof v === 'string' && v.trim() === '')
/** @param {any} e */
const messageOf = (e) => (e instanceof Error ? e.message : String(e))

/**
 * Is candidate an earlier copy than row? received_at first, then the smaller
 * id, so two copies can never flag each other.
 * @param {{ id: string, received_at: string|null }} candidate
 * @param {{ id: string, received_at: string|null }} row
 */
function isEarlier(candidate, row) {
  const a = Date.parse(String(candidate.received_at))
  const b = Date.parse(String(row.received_at))
  if (Number.isFinite(a) && Number.isFinite(b) && a !== b) return a < b
  return String(candidate.id) < String(row.id)
}

/**
 * The studio's cached Xero tax rates. A failed load is treated as no rates:
 * the row then asks a person for the rate instead of failing.
 * @param {import('@/lib/supabase').Db} db
 * @param {string} locationId
 * @returns {Promise<Array<{ tax_type: string, effective_rate: number|null, status: string|null, can_apply_to_expenses: boolean|null }>>}
 */
async function loadTaxRates(db, locationId) {
  const { data, error } = await db
    .from('xero_tax_rates')
    .select('tax_type, name, effective_rate, status, can_apply_to_expenses')
    .eq('location_id', locationId)
  if (error) {
    logWarn(MODULE, 'could not load tax rates', { location_id: locationId, error: error.message })
    return []
  }
  return data || []
}

/**
 * The supplier's remembered tax type, for vat_differs. Best effort.
 * @param {import('@/lib/supabase').Db} db
 * @param {string} locationId
 * @param {any} fields
 * @returns {Promise<string|null>}
 */
async function rememberedTaxTypeFor(db, locationId, fields) {
  const ref = fields?.xero_contact_ref
  if (ref?.kind !== 'existing' || blank(ref.xero_contact_id)) return null
  try {
    const def = await getSupplierDefault(db, locationId, ref.xero_contact_id)
    return def?.default_tax_type || null
  } catch (e) {
    logWarn(MODULE, 'could not load supplier default', { location_id: locationId, error: messageOf(e) })
    return null
  }
}

/**
 * Derive the tax type from the document's own figures. Only a derived type is
 * ever set here, and it always carries tax_type_source 'derived'. Mutates fields.
 * @param {any} fields
 * @param {Array<any>} taxRates
 */
function applyDerivedTaxType(fields, taxRates) {
  const vat = resolveBillTaxType(fields, taxRates)
  if (vat.taxType) {
    fields.tax_type = vat.taxType
    fields.tax_type_source = 'derived'
  } else {
    delete fields.tax_type
    delete fields.tax_type_source
  }
  return vat
}

/**
 * Another row at the studio from the same supplier with the same invoice
 * number, already extracted or further on. Returns the most recent one's id.
 *
 * The invoice number is matched trimmed and case-insensitively, which a
 * PostgREST filter cannot express, so the candidates (same studio, status and
 * contact id) are fetched and the number compared here.
 * @param {import('@/lib/supabase').Db} db
 * @param {{ id: string, location_id: string }} row
 * @param {any} fields
 * @returns {Promise<string|null>}
 */
async function findNumberDuplicate(db, row, fields) {
  const number = typeof fields?.invoice_number === 'string' ? fields.invoice_number.trim().toLowerCase() : ''
  const ref = fields?.xero_contact_ref
  if (!number || ref?.kind !== 'existing' || blank(ref.xero_contact_id)) return null
  const { data, error } = await db
    .from('invoices_queue')
    .select('id, received_at, invoice_number:extracted_fields->>invoice_number, contact_id:extracted_fields->xero_contact_ref->>xero_contact_id')
    .eq('location_id', row.location_id)
    .in('status', NUMBER_DUPLICATE_STATUSES)
    .neq('id', row.id)
    .eq('extracted_fields->xero_contact_ref->>xero_contact_id', ref.xero_contact_id)
    .order('received_at', { ascending: false })
    .limit(CANDIDATE_LIMIT)
  if (error) {
    logWarn(MODULE, 'could not check for a duplicate invoice number', { queue_id: row.id, error: error.message })
    return null
  }
  const hit = (data || []).find((c) =>
    c.contact_id === ref.xero_contact_id &&
    typeof c.invoice_number === 'string' && c.invoice_number.trim().toLowerCase() === number)
  return hit ? hit.id : null
}

/**
 * An earlier row at the studio holding the same file. Earlier is decided here
 * (see isEarlier) because the tie-break on id is not a PostgREST filter.
 * @param {import('@/lib/supabase').Db} db
 * @param {any} row
 * @param {string} hash
 * @returns {Promise<string|null>} the earliest copy's id
 */
async function findFileDuplicate(db, row, hash) {
  const { data, error } = await db
    .from('invoices_queue')
    .select('id, received_at, status')
    .eq('location_id', row.location_id)
    .eq('content_hash', hash)
    .neq('id', row.id)
    .order('received_at', { ascending: true })
    .limit(CANDIDATE_LIMIT)
  if (error) {
    // Read it anyway: a missed copy can still be caught by the number and Xero checks.
    logWarn(MODULE, 'could not check for a duplicate file', { queue_id: row.id, error: error.message })
    return null
  }
  const earlier = (data || [])
    .filter((c) => !NOT_COUNTED_FOR_FILE.has(String(c.status)) && isEarlier(c, row))
    .sort((a, b) => (isEarlier(a, b) ? -1 : 1))
  return earlier[0]?.id ?? null
}

/**
 * Prepare one claimed queue row: read it, check it and code it.
 *
 * @param {import('@/lib/supabase').Db} db  service-role client
 * @param {any} row  a full invoices_queue row, already claimed by the caller
 * @param {PrepareDeps} [deps]
 * @returns {Promise<PrepareResult>}
 */
export async function prepareInvoiceRow(db, row, deps = {}) {
  const nowIso = (deps.now ? deps.now() : new Date()).toISOString()
  // Filled in once known, so every later write (the fallback included) carries it.
  /** @type {{ content_hash?: string }} */
  const hashPatch = {}

  /**
   * One guarded write. False when the row has moved on (zero rows matched).
   * @param {Record<string, any>} patch
   */
  const write = async (patch) => {
    const { data, error } = await db
      .from('invoices_queue')
      .update({ ...hashPatch, ...patch, prepared_at: nowIso, analysis_queued_at: null, analysis_claimed_at: null })
      .eq('id', row.id)
      .eq('location_id', row.location_id)
      .in('status', PREPARABLE)
      .select('id')
    if (error) throw new Error(`write: ${error.message}`)
    return Array.isArray(data) && data.length > 0
  }

  /** @param {string} message @returns {Promise<PrepareResult>} */
  const unreadable = async (message) => {
    const ok = await write({ review_reasons: ['unreadable'], extraction_error: message, extracted_at: nowIso })
    return ok ? { outcome: 'unreadable', reasons: ['unreadable'] } : { outcome: 'skipped', reasons: [] }
  }

  try {
    return await prepare(db, row, deps, { write, unreadable, hashPatch, nowIso })
  } catch (e) {
    logError(MODULE, 'preparing an invoice failed', { queue_id: row?.id, error: messageOf(e) })
    try {
      return await unreadable(messageOf(e))
    } catch (e2) {
      // The database is not answering. The row keeps its claim, and the stale
      // claim is swept again later.
      logError(MODULE, 'could not record a failed preparation', { queue_id: row?.id, error: messageOf(e2) })
      return { outcome: 'unreadable', reasons: ['unreadable'] }
    }
  }
}

/**
 * @param {import('@/lib/supabase').Db} db
 * @param {any} row
 * @param {PrepareDeps} deps
 * @param {{
 *   write: (patch: Record<string, any>) => Promise<boolean>,
 *   unreadable: (message: string) => Promise<PrepareResult>,
 *   hashPatch: { content_hash?: string },
 *   nowIso: string,
 * }} io
 * @returns {Promise<PrepareResult>}
 */
async function prepare(db, row, deps, { write, unreadable, hashPatch, nowIso }) {
  /** @type {PrepareResult} */
  const skipped = { outcome: 'skipped', reasons: [] }
  const locationId = row.location_id

  // 1. No file.
  if (!row.attachment_path) {
    const ok = await write({ status: 'not_invoice', not_invoice_reason: row.not_invoice_reason || 'no_attachment', review_reasons: [] })
    return ok ? { outcome: 'not_invoice', reasons: [] } : skipped
  }

  // 2. Download from the row's own bucket.
  if (!row.attachment_bucket) return unreadable('download: no bucket')
  const { data: blob, error: dlErr } = await db.storage.from(row.attachment_bucket).download(row.attachment_path)
  if (dlErr || !blob) return unreadable(`download: ${dlErr?.message || 'unknown'}`)
  const bytes = NodeBuffer.from(await blob.arrayBuffer())
  // Every empty file has the same hash, so it must stop before the duplicate check.
  if (bytes.length === 0) return unreadable('download: empty file')

  // 3. Hash: backlog rows have none.
  const hash = row.content_hash || sha256Hex(bytes)
  if (!row.content_hash) hashPatch.content_hash = hash

  // 4. Duplicate by file: stop before reading, unless a person insisted.
  if (deps.force !== true) {
    const original = await findFileDuplicate(db, row, hash)
    if (original) {
      const ok = await write({ review_reasons: ['duplicate_file'], duplicate_of_id: original })
      return ok ? { outcome: 'duplicate', reasons: ['duplicate_file'] } : skipped
    }
  }

  // 5. Read. The read is paid for, so first make sure no one has acted on the
  // row meanwhile. A failed re-check never blocks: the final write is guarded anyway.
  const { data: current, error: statusErr } = await db
    .from('invoices_queue')
    .select('status')
    .eq('id', row.id)
    .eq('location_id', locationId)
    .maybeSingle()
  if (statusErr) {
    logWarn(MODULE, 'could not re-check the status before reading', { queue_id: row.id, error: statusErr.message })
  } else if (!current || !PREPARABLE.includes(String(current.status))) {
    return skipped
  }
  const extract = deps.extract || extractInvoiceFieldsFromBytes
  /** @type {{ ok: boolean, fields?: any, error?: string }} */
  const result = await extract(bytes, row.attachment_mime_type, { locationId })
  if (!result.ok || !result.fields) {
    // INVHARDEN.1 — a reader outage is not a bad file. On the queue (no person
    // waiting) the row stays queued and claimed, so the sweeper reads it again
    // once the claim goes stale; only the last attempt marks it unreadable.
    const attempt = readAttemptOf(row.extraction_error) + 1
    if (deps.force !== true && isTransientReadError(result.error) && attempt < MAX_READ_ATTEMPTS) {
      const { error: noteErr } = await db
        .from('invoices_queue')
        .update({ extraction_error: retryNote(attempt, result.error) })
        .eq('id', row.id)
        .eq('location_id', locationId)
        .in('status', PREPARABLE)
      if (noteErr) logWarn(MODULE, 'could not note a failed read attempt', { queue_id: row.id, error: noteErr.message })
      return skipped
    }
    return unreadable(result.error || 'extraction_failed')
  }
  // The reader never chooses the tax type: only a derived or a person's one stands.
  const { tax_type: _t, tax_type_source: _s, ...readFields } = result.fields
  /** @type {any} */
  let fields = readFields

  // Only the reader's say-so on an unvouched row sets it aside. A row a person
  // vouched for (quality_approved, e.g. restored or sent for analysis) is
  // prepared whatever the reader calls it, with the reasons the checks give.
  const documentType = fields.document_type
  if (NOT_INVOICE_TYPES.has(documentType) && row.status === 'received') {
    const ok = await write({
      status: 'not_invoice',
      not_invoice_reason: `document_type: ${documentType}`,
      extracted_fields: fields,
      extracted_at: nowIso,
      extraction_error: null,
      review_reasons: [],
    })
    return ok ? { outcome: 'not_invoice', reasons: [] } : skipped
  }

  // 6. Supplier and account.
  try {
    fields = { ...fields, ...(await resolveExtractionDefaults(db, locationId, fields.supplier_name)) }
  } catch (e) {
    logWarn(MODULE, 'could not resolve supplier defaults', { queue_id: row.id, error: messageOf(e) })
  }

  // 7. VAT.
  const taxRates = await loadTaxRates(db, locationId)
  const vat = applyDerivedTaxType(fields, taxRates)

  // 8. Duplicate by number, then already in Xero.
  /** @type {string[]} */
  const duplicateReasons = []
  /** @type {any} */
  let billContact = null
  const duplicateOf = await findNumberDuplicate(db, row, fields)
  if (duplicateOf) duplicateReasons.push('duplicate_number')
  if (!blank(fields.invoice_number)) {
    try {
      const lookup = (deps.xero || defaultXero).findBill(locationId, String(fields.invoice_number).trim())
      const bill = await withTimeout(lookup, deps.xeroTimeoutMs ?? XERO_LOOKUP_TIMEOUT_MS)
      if (bill) {
        duplicateReasons.push('already_in_xero')
        billContact = bill.Contact?.ContactID ? bill.Contact : null
      }
    } catch (e) {
      // No connection, a token failure, a network error or a timeout: tried once, no reason raised.
      logWarn(MODULE, 'could not look the bill up in Xero', { queue_id: row.id, error: messageOf(e) })
    }
  }
  // The bill in Xero names its supplier. When no rule matched one, it is used
  // only if it is an active contact here whose name agrees with the document:
  // two suppliers can share an invoice number.
  if (billContact && !fields.xero_contact_ref) {
    try {
      const contact = await contactFromXeroBill(db, locationId, fields.supplier_name, billContact)
      if (contact) fields = { ...fields, ...(await defaultsForContact(db, locationId, contact)) }
    } catch (e) {
      logWarn(MODULE, 'could not take the supplier from the Xero bill', { queue_id: row.id, error: messageOf(e) })
    }
  }
  const rememberedTaxType = await rememberedTaxTypeFor(db, locationId, fields)

  // 9. Write.
  const reasons = mergeReasons(fieldReasons(fields, { vat, rememberedTaxType, taxRates }), duplicateReasons)
  const ok = await write({
    status: 'extracted',
    extracted_at: nowIso,
    extracted_fields: fields,
    extraction_confidence: scoreExtractionConfidence(fields),
    extraction_error: null,
    duplicate_of_id: duplicateOf,
    review_reasons: reasons,
  })
  return ok ? { outcome: 'prepared', reasons } : skipped
}

/**
 * Recompute an extracted row's reasons after a person edits its fields. No
 * download, no read and no Xero call: already_in_xero and duplicate_file are
 * carried over as they are. Never throws.
 *
 * @param {import('@/lib/supabase').Db} db  service-role client
 * @param {any} row  the invoices_queue row, with the edited extracted_fields
 * @param {{ rematchSupplier?: boolean }} [opts]  rematchSupplier: look again
 *   for the supplier of a row that has none, and re-stamp prepared_at
 * @returns {Promise<{ reasons: string[], fields: any }>} the reasons and the
 *   extracted_fields as stored afterwards (the row's own when nothing was written)
 */
export async function recheckInvoiceRow(db, row, opts = {}) {
  /** @type {string[]} */
  const existing = Array.isArray(row?.review_reasons) ? row.review_reasons : []
  const unchanged = () => ({ reasons: existing, fields: row?.extracted_fields ?? null })
  try {
    if (!row || row.status !== 'extracted') return unchanged()
    const locationId = row.location_id
    const fields = { ...(row.extracted_fields || {}) }
    // A later look for the supplier: only for a row that has none, so a
    // person's pick is never replaced.
    let supplierFound = false
    if (opts.rematchSupplier === true && !fields.xero_contact_ref) {
      /** @type {any} */
      const found = await resolveExtractionDefaults(db, locationId, fields.supplier_name)
      if (found.xero_contact_ref) {
        Object.assign(fields, found)
        supplierFound = true
      }
    }
    const taxRates = await loadTaxRates(db, locationId)

    // A person's tax type, or a legacy one with no source, is left exactly as it is.
    const rederive = fields.tax_type_source !== 'manual' && (blank(fields.tax_type) || fields.tax_type_source === 'derived')
    const before = JSON.stringify([fields.tax_type ?? null, fields.tax_type_source ?? null])
    const vat = rederive ? applyDerivedTaxType(fields, taxRates) : resolveBillTaxType(fields, taxRates)
    const vatChanged = JSON.stringify([fields.tax_type ?? null, fields.tax_type_source ?? null]) !== before

    const rememberedTaxType = await rememberedTaxTypeFor(db, locationId, fields)
    const carried = existing.filter((r) => CARRIED_ON_RECHECK.has(r))
    const duplicateOf = await findNumberDuplicate(db, row, fields)
    const reasons = mergeReasons(
      fieldReasons(fields, { vat, rememberedTaxType, taxRates }),
      carried,
      duplicateOf ? ['duplicate_number'] : [],
    )

    const fieldsChanged = vatChanged || supplierFound
    // The supplier pass re-stamps the row so it is looked at once per change.
    const stamp = opts.rematchSupplier === true ? { prepared_at: new Date().toISOString() } : {}
    const patch = fieldsChanged
      ? { review_reasons: reasons, duplicate_of_id: duplicateOf, extracted_fields: fields, ...stamp }
      : { review_reasons: reasons, duplicate_of_id: duplicateOf, ...stamp }
    const { data, error } = await db
      .from('invoices_queue')
      .update(patch)
      .eq('id', row.id)
      .eq('location_id', locationId)
      .eq('status', 'extracted')
      .select('id')
    if (error) {
      logError(MODULE, 'could not save rechecked reasons', { queue_id: row.id, error: error.message })
      return unchanged()
    }
    // The row moved on before the write: what is stored still stands.
    if (!Array.isArray(data) || data.length === 0) return unchanged()
    return { reasons, fields: fieldsChanged ? fields : row.extracted_fields ?? null }
  } catch (e) {
    logError(MODULE, 'recheck failed', { queue_id: row?.id, error: messageOf(e) })
    return unchanged()
  }
}
