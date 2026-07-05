// XERO-API.3 PR 3 — direct /Invoices API push (replaces Postmark email).
//
// Why this replaces forward.js
// ----------------------------
// The Postmark→Hubdoc loop re-OCRs the attachment on Xero's side
// every time, and Hubdoc accuracy on UK/IE supplier invoices is
// noticeably worse than what the bookkeeper just confirmed in
// /invoices review. By pushing structured fields directly, the
// draft bill arrives in Xero already correct — supplier
// resolved, total set, line items pre-coded to the right account.
//
// Inputs the bookkeeper has already picked (PR 2):
//   - extracted_fields.xero_contact_ref  → which Xero Contact
//   - extracted_fields.xero_account_id   → which Account (we use
//     extracted_fields.account_code mirrored alongside as the
//     human-shaped value Xero's LineItems.AccountCode expects)
//
// Output on success: { billId, billNumber, deepLinkUrl }
//   billId          — Xero InvoiceID (GUID-shaped string)
//   billNumber      — Xero-assigned InvoiceNumber (e.g. INV-0001)
//   deepLinkUrl     — direct https://go.xero.com link to the
//                     draft bill, so the inbox UI can offer an
//                     "Open in Xero" button.

import { createServerClient } from '@/lib/supabase'
import { withFreshToken, XeroError } from '@/lib/xero/client'
import { attachInvoiceFile } from '@/lib/xero/attachments'

// ---------------------------------------------------------------
// Contact resolution
// ---------------------------------------------------------------

function escapeWhereString(str) {
  return String(str).replace(/'/g, "''")
}

// Infer a Content-Type from a filename extension. Xero can reject an
// attachment sent as application/octet-stream, so fall back to the
// extension when the stored MIME type is missing/generic.
function inferMimeFromName(name) {
  const ext = String(name || '').toLowerCase().split('.').pop()
  return {
    pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  }[ext] || 'application/octet-stream'
}

// Look up an existing Xero ACCPAY bill by its supplier invoice number.
// Returns the matching Xero invoice ({ InvoiceID, InvoiceNumber, Status,
// ... }) or null. Shared by the create-time duplicate guard and the
// bulk "mark as already in Xero" reconciliation endpoint.
export async function findXeroBillByNumber(xfetch, invoiceNumber) {
  const num = (invoiceNumber || '').trim()
  if (!num) return null
  const where = encodeURIComponent(`Type=="ACCPAY" AND InvoiceNumber=="${escapeWhereString(num)}"`)
  const res = await xfetch(`/Invoices?where=${where}`).catch((e) => {
    if (e.status === 404) return null
    throw e
  })
  return (res?.Invoices || []).find((i) => (i.InvoiceNumber || '') === num) || null
}

export function xeroBillDeepLink(invoiceId) {
  return `https://go.xero.com/AccountsPayable/View.aspx?InvoiceID=${invoiceId}`
}

/**
 * Resolve the xero_contact_ref to a concrete ContactID.
 *   - kind='existing' → return the stored xero_contact_id directly.
 *   - kind='new'      → look up by Name (case-insensitive); if
 *                       found return that ID (handles the race
 *                       where someone created the contact in Xero
 *                       between picker fetch + send), else POST a
 *                       new Contact with IsSupplier=true.
 *
 * Also pokes the local xero_contacts cache with the new ID so
 * subsequent picker requests find it.
 */
async function resolveContactId({ xfetch, db, locationId, contactRef }) {
  if (!contactRef) {
    throw new XeroError('Cannot push to Xero — no Xero supplier picked.')
  }

  if (contactRef.kind === 'existing') {
    return contactRef.xero_contact_id
  }

  if (contactRef.kind === 'new') {
    const name = (contactRef.name || '').trim()
    if (!name) {
      throw new XeroError('Cannot create a Xero contact with an empty name.')
    }

    // Race-guard lookup first — bookkeeper may have created the
    // contact directly in Xero after our cache last refreshed, in
    // which case we'd otherwise hit a duplicate-name error.
    const where = encodeURIComponent(`Name="${escapeWhereString(name)}"`)
    const lookup = await xfetch(`/Contacts?where=${where}`).catch((e) => {
      if (e.status === 404) return null
      throw e
    })
    if (lookup?.Contacts?.length) {
      const existing = lookup.Contacts[0]
      // Backfill the cache so PR 2's picker stops nudging "create new".
      await db.from('xero_contacts').upsert({
        location_id: locationId,
        xero_contact_id: existing.ContactID,
        name: existing.Name || name,
        email: existing.EmailAddress || null,
        is_supplier: true,
        is_customer: false,
        status: existing.ContactStatus || 'ACTIVE',
        last_synced_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }, { onConflict: 'location_id,xero_contact_id' })
      return existing.ContactID
    }

    // Truly new — create.
    const created = await xfetch('/Contacts', {
      method: 'POST',
      body: { Contacts: [{ Name: name, IsSupplier: true }] },
    })
    const newId = created?.Contacts?.[0]?.ContactID
    if (!newId) {
      throw new XeroError('Xero returned no ContactID for the newly-created supplier.', { body: created })
    }

    // Add to local cache so the bookkeeper can pick it next time
    // without a manual Refresh.
    await db.from('xero_contacts').upsert({
      location_id: locationId,
      xero_contact_id: newId,
      name,
      email: null,
      is_supplier: true,
      is_customer: false,
      status: 'ACTIVE',
      last_synced_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }, { onConflict: 'location_id,xero_contact_id' })

    return newId
  }

  throw new XeroError(`Unknown xero_contact_ref.kind: ${contactRef.kind}`)
}

// ---------------------------------------------------------------
// Payload builder
// ---------------------------------------------------------------

/**
 * Decide the Xero TaxType for a single bill line.
 *
 * XERO-BILL-VAT.2 — a bookkeeper-confirmed `fields.tax_type` (derived
 * from the location's synced Xero rates and confirmed in review) wins
 * for every line, over both the zero-VAT default and the account
 * cache. It's a guaranteed-valid code for that location's tenant.
 *
 * XERO-BILL-VAT.1 fallback for legacy rows with no confirmed type:
 * this used to be omitted entirely, so with LineAmountTypes:'Exclusive'
 * Xero fell back to the *account's* default rate and silently added
 * 23% to a 0%-VAT supplier bill (ROWfit 23967: €156.84 booked as
 * €192.91). We now stamp it:
 *   - Source doc has 0% / no VAT (tax_amount === 0) → 'NONE'
 *     (No VAT). A universal, always-valid Xero tax type that books
 *     zero tax regardless of what the account defaults to.
 *   - Otherwise use the line account's OWN tax type, resolved from
 *     the xero_accounts cache (mig 186) — a guaranteed-valid code
 *     for that org, so the draft books under the same rate the
 *     account already uses in Xero (mirrors xero/invoices.js).
 *   - Unknown account (cache miss / no code) → return undefined so
 *     the caller omits TaxType and Xero applies the account default,
 *     exactly as before. Safe no-op fallback, never an invalid code.
 */
export function resolveLineTaxType(fields, accountTaxTypes, code) {
  // XERO-BILL-VAT.2 — a bookkeeper-confirmed tax_type (derived from
  // the location's synced Xero rates + confirmed in review) wins for
  // every line.
  if (typeof fields?.tax_type === 'string' && fields.tax_type) return fields.tax_type
  // XERO-BILL-VAT.1 fallback for legacy rows with no confirmed type.
  const taxAmount = Number(fields?.tax_amount)
  if (Number.isFinite(taxAmount) && taxAmount === 0) return 'NONE'
  return (code != null ? accountTaxTypes?.[String(code)] : undefined) || undefined
}

/**
 * Build LineItems from the extracted fields. If the row has
 * structured line_items[] use them; otherwise synthesise a single
 * line carrying the invoice total — Xero rejects zero-line bills.
 *
 * The picker-confirmed `account_code` is stamped on every line so
 * the draft bill arrives in Xero already coded to the right
 * account. (Per-line account_code overrides on individual
 * line_items[] entries are honoured if present.) `accountTaxTypes`
 * maps account code → Xero tax type (from the xero_accounts cache)
 * so each line also carries the right TaxType.
 */
function buildLineItems(fields, accountTaxTypes = {}) {
  const defaultCode = fields.account_code || null
  if (!Array.isArray(fields.line_items) || fields.line_items.length === 0) {
    const taxType = resolveLineTaxType(fields, accountTaxTypes, defaultCode)
    return [{
      Description: `Invoice ${fields.invoice_number || ''} from ${fields.supplier_name || ''}`.trim() || '(invoice)',
      Quantity: 1,
      UnitAmount: Number(fields.subtotal ?? fields.total ?? 0),
      ...(defaultCode ? { AccountCode: String(defaultCode) } : {}),
      ...(taxType ? { TaxType: taxType } : {}),
    }]
  }
  return fields.line_items.map((li) => {
    // Per-line override beats the row default (both for the account
    // code and, through it, the tax type).
    const code = li.account_code || defaultCode
    const taxType = resolveLineTaxType(fields, accountTaxTypes, code)
    return {
      Description: String(li.description || '').slice(0, 4000) || '(no description)',
      Quantity: Number(li.quantity ?? 1),
      UnitAmount: Number(li.unit_amount ?? 0),
      ...(code ? { AccountCode: String(code) } : {}),
      ...(taxType ? { TaxType: taxType } : {}),
    }
  })
}

/**
 * Compose the /Invoices POST body. Pure — exported for unit
 * testing. `accountTaxTypes` (account code → Xero tax type) is
 * resolved by the caller from the xero_accounts cache.
 */
export function buildBillPayload(fields, { supplierContactId, accountTaxTypes = {} }) {
  return {
    Type: 'ACCPAY',
    Status: 'DRAFT',
    Contact: { ContactID: supplierContactId },
    Date: fields.invoice_date,
    ...(fields.due_date ? { DueDate: fields.due_date } : {}),
    InvoiceNumber: fields.invoice_number,
    Reference: fields.invoice_number,
    CurrencyCode: fields.currency || 'EUR',
    // Xero defaults to Exclusive when omitted, but being explicit
    // means we don't get caught out by org-level default changes.
    // Each LineItem now carries its own TaxType (see
    // resolveLineTaxType) so Xero books the tax we mean, not the
    // account default.
    LineAmountTypes: 'Exclusive',
    LineItems: buildLineItems(fields, accountTaxTypes),
  }
}

/**
 * Resolve every account code referenced by a bill (the row default
 * plus any per-line overrides) to its Xero tax type, from the local
 * xero_accounts cache (mig 186). Returns a plain map code→tax_type;
 * missing/unknown codes are simply absent (caller treats as
 * "omit TaxType, let Xero default"). Never throws — a cache miss
 * degrades to prior behaviour rather than blocking the send.
 */
async function fetchAccountTaxTypes(db, locationId, fields) {
  const codes = [
    fields.account_code,
    ...(Array.isArray(fields.line_items) ? fields.line_items.map((li) => li?.account_code) : []),
  ].filter(Boolean).map(String)
  const unique = [...new Set(codes)]
  if (!unique.length) return {}
  const { data } = await db
    .from('xero_accounts')
    .select('code, tax_type')
    .eq('location_id', locationId)
    .in('code', unique)
  const map = {}
  for (const r of (data || [])) {
    if (r?.code != null && r?.tax_type) map[String(r.code)] = r.tax_type
  }
  return map
}

// ---------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------

/**
 * Push a queue row to Xero as a draft ACCPAY bill via /Invoices.
 *
 * @param {string} queueId
 * @returns {Promise<{ billId: string, billNumber: string, deepLinkUrl: string }>}
 *
 * Throws XeroError on:
 *   - Missing / wrong-state queue row
 *   - Missing xero_account_id / xero_contact_ref (server-side
 *     enforcement of the PR 2 UI gate)
 *   - Xero API failure (token, network, validation)
 */
export async function pushQueueRowToXero(queueId) {
  const db = createServerClient()

  const { data: row, error: loadErr } = await db
    .from('invoices_queue')
    .select(`
      id, location_id, status, source_type, extracted_fields,
      attachment_bucket, attachment_path, attachment_filename, attachment_mime_type,
      xero_bill_id, xero_bill_number, xero_deep_link_url,
      location:location_id ( id, name )
    `)
    .eq('id', queueId)
    .single()
  if (loadErr || !row) throw new XeroError('Queue row not found.')
  if (row.status !== 'data_approved') {
    throw new XeroError(
      `Cannot push a queue row in '${row.status}' state — must be data_approved.`
    )
  }

  const fields = row.extracted_fields || {}
  if (!fields.xero_account_id || !fields.account_code) {
    throw new XeroError('No Xero account picked. Open the row in /invoices and choose an account before sending.')
  }
  if (!fields.xero_contact_ref) {
    throw new XeroError('No Xero supplier picked. Open the row in /invoices and choose a supplier before sending.')
  }

  // OAuth + tenant lookup. withFreshToken returns the connection
  // alongside xfetch so we can compute the deep-link URL with the
  // right tenant_id.
  const { conn, xfetch } = await withFreshToken(row.location_id)

  const deepLink = xeroBillDeepLink

  let billId = row.xero_bill_id || null
  let billNumber = row.xero_bill_number || fields.invoice_number || null
  let deepLinkUrl = row.xero_deep_link_url || (billId ? deepLink(billId) : null)

  if (!billId) {
    // CREATE PATH. First make sure we're not duplicating a bill that
    // already exists in Xero — a prior orphaned push, a manual entry,
    // or (during the Dext migration) one Dext already created. Policy
    // is SKIP + FLAG: never touch the existing bill.
    const match = await findXeroBillByNumber(xfetch, fields.invoice_number)
    if (match) {
      throw new XeroError(
        `Already in Xero as bill ${match.InvoiceNumber} (status ${match.Status}). Skipped to avoid a duplicate — open it in Xero to reconcile, or reject this row.`,
        { status: 409, code: 'already_in_xero', body: match },
      )
    }

    // Resolve / create the supplier contact (only needed to create).
    const supplierContactId = await resolveContactId({
      xfetch, db, locationId: row.location_id, contactRef: fields.xero_contact_ref,
    })

    // Resolve each line's Xero tax type from the account cache so the
    // draft books under the right rate (0%-VAT → 'NONE'), instead of
    // letting Xero apply the account default. See resolveLineTaxType.
    const accountTaxTypes = await fetchAccountTaxTypes(db, row.location_id, fields)
    const payload = buildBillPayload(fields, { supplierContactId, accountTaxTypes })
    const created = await xfetch('/Invoices', { method: 'POST', body: { Invoices: [payload] } })
    const inv = created?.Invoices?.[0]
    if (!inv?.InvoiceID) {
      throw new XeroError('Xero returned no InvoiceID for the created draft bill.', { body: created })
    }
    billId = inv.InvoiceID
    billNumber = inv.InvoiceNumber || fields.invoice_number || null
    deepLinkUrl = deepLink(billId)

    // audit F2 (RCOV.P2) — record what Xero booked as tax vs what the
    // OCR read off the receipt. We now stamp each line's TaxType
    // (XERO-BILL-VAT.1) so Xero books the rate we mean, but this
    // cross-check stays as the backstop that catches any remaining
    // drift — this is the only place the two numbers meet. >2c
    // difference = mismatch (Irish multi-rate 23/13.5/9/0 makes silent
    // drift easy, esp. reduced rates we can't yet infer from a bare
    // tax amount);
    // null when either side is missing (pre-P2 rows stay null = not
    // evaluated). Surfaced in the inbox badge + /accounting Exceptions.
    const xeroTotalTax = typeof inv.TotalTax === 'number' ? inv.TotalTax : null
    const ocrTax = typeof fields.tax_amount === 'number' ? fields.tax_amount : null
    const taxMismatch = xeroTotalTax == null || ocrTax == null
      ? null
      : Math.abs(xeroTotalTax - ocrTax) > 0.02

    // Persist the bill id IMMEDIATELY, before attaching. If the
    // attachment then fails, a retry reuses this id (skips create
    // above) and re-attaches instead of creating a duplicate bill.
    await db.from('invoices_queue').update({
      xero_bill_id: billId,
      xero_bill_number: billNumber,
      xero_deep_link_url: deepLinkUrl,
      xero_total_tax: xeroTotalTax,
      xero_tax_mismatch: taxMismatch,
    }).eq('id', queueId)
  }
  // else: idempotent retry — the bill already exists from a previous
  // attempt; fall through and (re)attach the source file to it.

  // XERO-ATTACH.1 — attach the original supplier document to the bill
  // so the source travels to Xero (the CRM is the sole path now that
  // Dext is being retired). Failures are NO LONGER swallowed: we
  // report them so the caller can leave the row unsent and the
  // operator can retry, which re-attaches to the same bill.
  let attachmentError = null
  if (row.attachment_bucket && row.attachment_path) {
    try {
      const { data: blob, error: dlErr } = await db.storage
        .from(row.attachment_bucket)
        .download(row.attachment_path)
      if (dlErr || !blob) throw new Error(dlErr?.message || 'storage download returned no file')
      const bytes = Buffer.from(await blob.arrayBuffer())
      const fname = row.attachment_filename || `invoice-${fields.invoice_number || billId}`
      await attachInvoiceFile(xfetch, billId, {
        filename: fname,
        mimeType: row.attachment_mime_type || inferMimeFromName(fname),
        bytes,
      })
    } catch (e) {
      attachmentError = e?.message || String(e)
      console.warn(`[push-xero ${queueId}] attachment upload failed (bill ${billId} created): ${attachmentError}`)
    }
  }

  return {
    billId,
    billNumber,
    deepLinkUrl,
    attachmentError,
    sentTo: conn?.tenant_name || conn?.tenant_id || null,
  }
}
