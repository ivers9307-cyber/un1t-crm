// INVOICE-OCR.1 — Push a Claude Vision-extracted supplier invoice
// into Xero as a DRAFT ACCPAY bill via /Invoices API.
//
// Differs from ./bills-email.js + ./contractor-bills.js (both
// rely on Xero's email-to-bills inbox + Hubdoc OCR) — those paths
// attach the raw PDF and let Xero's side do extraction. This one
// pushes the structured fields the operator just reviewed, so what
// lands in Xero is a fully-populated draft with the right supplier,
// line items, totals, dates, no second-OCR-pass needed.
//
// Why ACCPAY drafts and not AUTHORISED:
//   - The bill is still operator-reviewed but final approval +
//     payment scheduling happens inside Xero (accountant's
//     workflow). DRAFT keeps Xero's controls (approval queue,
//     batch payments) intact.
//
// Flow:
//   1. validateExtractedFields()  — schema sanity-check (the same
//      shape invoice-extraction.js produces; defence in depth in
//      case the JSONB drifted in storage).
//   2. upsertSupplierContact()    — find by name → create. Xero
//      Contacts is a flat namespace so name-only matching is the
//      common pattern.
//   3. POST /Invoices             — Type=ACCPAY, Status=DRAFT,
//      Contact={ContactID}, LineItems[].
//   4. Return { ok, billId, billNumber, deepLinkUrl } so the
//      caller can persist + show in the UI.

import { withFreshToken, XeroError } from './client'
import { invoiceFieldsSchema } from '@/lib/invoice-extraction'

function escapeWhereString(str) {
  return String(str).replace(/'/g, "''")
}

/**
 * Find an existing Contact by name (case-insensitive match) OR
 * create one with the extracted supplier_name + address. Returns
 * the Xero ContactID.
 */
async function upsertSupplierContact(xfetch, { name, address }) {
  if (!name || !String(name).trim()) {
    throw new XeroError('Cannot push to Xero — supplier name is empty.')
  }
  const trimmed = name.trim()

  // Xero's `Name` filter is case-insensitive for exact match in
  // the WHERE clause when wrapped in quotes.
  const where = encodeURIComponent(`Name="${escapeWhereString(trimmed)}"`)
  const lookup = await xfetch(`/Contacts?where=${where}`).catch((e) => {
    // 404 from /Contacts with no matches is a quirk on some Xero
    // org states; treat as "not found, will create".
    if (e.status === 404) return null
    throw e
  })
  if (lookup?.Contacts?.length) {
    return lookup.Contacts[0].ContactID
  }

  // Create. We always set IsSupplier=true so the contact shows
  // up in Bills' supplier picker.
  const created = await xfetch('/Contacts', {
    method: 'POST',
    body: {
      Contacts: [{
        Name: trimmed,
        IsSupplier: true,
        ...(address ? {
          Addresses: [{
            AddressType: 'POBOX',
            AddressLine1: String(address).slice(0, 500),
          }],
        } : {}),
      }],
    },
  })
  const newId = created?.Contacts?.[0]?.ContactID
  if (!newId) {
    throw new XeroError('Xero returned no ContactID for the newly-created supplier.', { body: created })
  }
  return newId
}

/**
 * Build the LineItems payload from the extracted line_items array.
 *
 * Xero ACCPAY lines require:
 *   - Description
 *   - Quantity
 *   - UnitAmount
 *   - AccountCode (optional but recommended; if absent we leave it
 *     for the accountant to set in Xero)
 *
 * We pass through whatever Claude extracted; the operator reviews
 * + edits before this is called, so the values are operator-blessed.
 */
function buildLineItems(fields) {
  if (!Array.isArray(fields.line_items) || fields.line_items.length === 0) {
    // Fall back to a single line carrying the invoice total — Xero
    // rejects zero-line bills.
    return [{
      Description: `Invoice ${fields.invoice_number} from ${fields.supplier_name}`,
      Quantity: 1,
      UnitAmount: Number(fields.subtotal ?? fields.total ?? 0),
    }]
  }
  return fields.line_items.map((li) => ({
    Description: String(li.description || '').slice(0, 4000) || '(no description)',
    Quantity: Number(li.quantity ?? 1),
    UnitAmount: Number(li.unit_amount ?? 0),
    ...(li.account_code ? { AccountCode: String(li.account_code) } : {}),
  }))
}

/**
 * Convert the validated extraction shape into Xero's Invoice
 * payload. Pure — exported for unit tests.
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
    LineAmountTypes: 'Exclusive', // line UnitAmounts exclude tax; Xero applies tax per line
    LineItems: buildLineItems(fields),
  }
}

/**
 * Top-level: push extracted invoice fields to Xero as a DRAFT
 * ACCPAY bill. Returns the resulting IDs + deep-link.
 *
 * @param {object} args
 * @param {string} args.locationId   The location whose Xero org receives the bill.
 * @param {object} args.fields       Already validated against invoiceFieldsSchema.
 * @returns {Promise<{ ok: true, billId, invoiceNumber, deepLinkUrl } | { ok: false, error, status? }>}
 */
export async function pushExtractedInvoiceToXero({ locationId, fields }) {
  // Belt-and-braces re-validation. The DB column is JSONB so the
  // shape can drift if anything writes a malformed object. Caller
  // can rely on this throwing on a bad payload.
  const parsed = invoiceFieldsSchema.safeParse(fields)
  if (!parsed.success) {
    return {
      ok: false,
      error: `Extracted fields fail schema: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    }
  }
  const validFields = parsed.data

  try {
    const xfetch = await withFreshToken(locationId)

    const supplierContactId = await upsertSupplierContact(xfetch, {
      name: validFields.supplier_name,
      address: validFields.supplier_address || null,
    })

    const payload = buildBillPayload(validFields, { supplierContactId })

    const created = await xfetch('/Invoices', {
      method: 'POST',
      body: { Invoices: [payload] },
    })

    const inv = created?.Invoices?.[0]
    if (!inv?.InvoiceID) {
      return {
        ok: false,
        error: 'Xero returned no InvoiceID for the created draft bill.',
      }
    }

    // Deep link the operator into the Xero Bills view for this
    // invoice. Xero's stable bill URL pattern.
    const deepLinkUrl = `https://go.xero.com/AccountsPayable/View.aspx?InvoiceID=${inv.InvoiceID}`

    return {
      ok: true,
      billId: inv.InvoiceID,
      invoiceNumber: inv.InvoiceNumber || validFields.invoice_number,
      deepLinkUrl,
    }
  } catch (e) {
    return {
      ok: false,
      error: e?.message || 'Xero push failed.',
      status: e instanceof XeroError ? e.status : undefined,
    }
  }
}
