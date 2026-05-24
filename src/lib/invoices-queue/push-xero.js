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
 * Build LineItems from the extracted fields. If the row has
 * structured line_items[] use them; otherwise synthesise a single
 * line carrying the invoice total — Xero rejects zero-line bills.
 *
 * The picker-confirmed `account_code` is stamped on every line so
 * the draft bill arrives in Xero already coded to the right
 * account. (Per-line account_code overrides on individual
 * line_items[] entries are honoured if present.)
 */
function buildLineItems(fields) {
  const defaultCode = fields.account_code || null
  if (!Array.isArray(fields.line_items) || fields.line_items.length === 0) {
    return [{
      Description: `Invoice ${fields.invoice_number || ''} from ${fields.supplier_name || ''}`.trim() || '(invoice)',
      Quantity: 1,
      UnitAmount: Number(fields.subtotal ?? fields.total ?? 0),
      ...(defaultCode ? { AccountCode: String(defaultCode) } : {}),
    }]
  }
  return fields.line_items.map((li) => ({
    Description: String(li.description || '').slice(0, 4000) || '(no description)',
    Quantity: Number(li.quantity ?? 1),
    UnitAmount: Number(li.unit_amount ?? 0),
    // Per-line override beats the row default.
    ...(li.account_code || defaultCode ? { AccountCode: String(li.account_code || defaultCode) } : {}),
  }))
}

/**
 * Compose the /Invoices POST body. Pure — exported for unit
 * testing.
 */
export function buildBillPayload(fields, { supplierContactId }) {
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
    LineAmountTypes: 'Exclusive',
    LineItems: buildLineItems(fields),
  }
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

  // Resolve / create the contact. Hands back a stable ContactID
  // suitable for /Invoices.Contact.ContactID.
  const supplierContactId = await resolveContactId({
    xfetch, db, locationId: row.location_id, contactRef: fields.xero_contact_ref,
  })

  // POST /Invoices.
  const payload = buildBillPayload(fields, { supplierContactId })
  const created = await xfetch('/Invoices', {
    method: 'POST',
    body: { Invoices: [payload] },
  })
  const inv = created?.Invoices?.[0]
  if (!inv?.InvoiceID) {
    throw new XeroError('Xero returned no InvoiceID for the created draft bill.', { body: created })
  }

  // XERO-ATTACH.1 — attach the original supplier document to the
  // draft bill, so the bookkeeper sees the source PDF alongside the
  // figures in Xero (the Dext-style "source attached" behaviour).
  // Best-effort: the bill is already created, so an attachment
  // failure must not fail the push — it's logged and swallowed.
  if (row.attachment_bucket && row.attachment_path) {
    try {
      const { data: blob, error: dlErr } = await db.storage
        .from(row.attachment_bucket)
        .download(row.attachment_path)
      if (dlErr || !blob) throw new Error(dlErr?.message || 'storage download returned no file')
      const bytes = Buffer.from(await blob.arrayBuffer())
      await attachInvoiceFile(xfetch, inv.InvoiceID, {
        filename: row.attachment_filename || `invoice-${fields.invoice_number || inv.InvoiceID}.pdf`,
        mimeType: row.attachment_mime_type,
        bytes,
      })
    } catch (e) {
      console.warn(`[push-xero ${queueId}] attachment upload failed (bill ${inv.InvoiceID} still created): ${e?.message || e}`)
    }
  }

  // Deep link — Xero's stable Bills-to-pay URL pattern. This
  // works when the user already has the right tenant active in
  // Xero (the common case). For users who are members of multiple
  // tenants Xero will prompt them to switch; that's acceptable
  // since most operators have a single tenant active at a time.
  const deepLinkUrl = `https://go.xero.com/AccountsPayable/View.aspx?InvoiceID=${inv.InvoiceID}`

  return {
    billId: inv.InvoiceID,
    billNumber: inv.InvoiceNumber || fields.invoice_number || null,
    deepLinkUrl,
    sentTo: conn?.tenant_name || conn?.tenant_id || null,
  }
}
