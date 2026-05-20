// Customer invoice push for completed cars (v2).
//
// Flow on issue:
//   1. validateInvoiceFields(car)        — bail early with a clear
//                                          error if anything's missing
//   2. resolveBrandingThemeId(xfetch)    — find the "Car" theme by
//                                          name (overridable via
//                                          XERO_BRANDING_THEME_NAME)
//   3. upsertContact()                   — find by email → name →
//                                          create. If matched but
//                                          no email on file, patch
//                                          the email in so Xero can
//                                          actually email the buyer.
//   4. POST /Invoices                    — AUTHORISED, with branding
//   5. POST /Invoices/{id}/Email         — Xero emails the invoice
//                                          using the contact's email
//   6. GET /Invoices/{id} (Accept: pdf)  — download the PDF
//   7. Upload PDF → Supabase Storage     — private bucket
//                                          car-documents, key
//                                          cars/{id}/xero-invoice-{n}.pdf
//   8. caller persists every column      — incl. xero_invoice_amount
//                                          for drift detection
//
// Void & reissue:
//   voidCarInvoice(car) PUTs the existing invoice with Status: VOIDED.
//   Caller then clears the xero_invoice_* columns and (optionally)
//   calls issueCarInvoice(car) again. UI surfaces the button when
//   current irish_sale_price_ex_vat differs from
//   car.xero_invoice_amount.

import { withFreshToken, XeroError } from './client'
import { createServerClient } from '@/lib/supabase'
import { logWarn } from '@/lib/log'

const IE_OUTPUT_VAT = 'OUTPUT2'                 // Irish 23% standard rate
const STORAGE_BUCKET = 'car-documents'

// Branding theme name — overridable via env if the user renames it
// in Xero. Defaults to "Car" per the Xero org's existing theme.
const BRANDING_THEME_NAME = process.env.XERO_BRANDING_THEME_NAME || 'Car'

function escapeWhereString(str) {
  return String(str).replace(/'/g, "''")
}

// ── Validation ──────────────────────────────────────────────────
//
// Returns an array of human-readable error strings — empty array
// means good to push. Surfaces both individually-missing fields and
// shape errors (e.g. ex-VAT must be > 0).
export function validateInvoiceFields(car) {
  const errors = []
  if (!car) return ['No car provided.']
  if (!car.location_id) errors.push('Car has no location assigned.')
  if (!car.buyer_name || !String(car.buyer_name).trim()) {
    errors.push('Buyer name is required.')
  }
  if (!car.buyer_email || !String(car.buyer_email).trim()) {
    errors.push('Buyer email is required (used to email the invoice).')
  }
  const exVat = Number(car.irish_sale_price_ex_vat)
  if (!Number.isFinite(exVat) || exVat <= 0) {
    errors.push('IE ex-VAT sale price must be set and greater than zero.')
  }
  return errors
}

// ── Branding theme resolution ───────────────────────────────────
async function resolveBrandingThemeId(xfetch, name = BRANDING_THEME_NAME) {
  if (!name) return null
  try {
    const json = await xfetch('/BrandingThemes')
    const themes = json?.BrandingThemes || []
    const match = themes.find(t => (t.Name || '').toLowerCase() === name.toLowerCase())
    return match?.BrandingThemeID || null
  } catch (e) {
    // Theme lookup failure shouldn't block the invoice — Xero will
    // fall back to the org's default. Surface a warning in the
    // structured response so the UI can show it.
    logWarn('xero', `Could not resolve branding theme "${name}"`, { err: e })
    return null
  }
}

// ── Contact handling ────────────────────────────────────────────
async function findContact(xfetch, { email, name }) {
  if (email) {
    const where = encodeURIComponent(`EmailAddress="${escapeWhereString(email)}"`)
    const json = await xfetch(`/Contacts?where=${where}`).catch(e => {
      if (e.status === 404) return null
      throw e
    })
    if (json?.Contacts?.length) return json.Contacts[0]
  }
  if (name) {
    const where = encodeURIComponent(`Name="${escapeWhereString(name)}"`)
    const json = await xfetch(`/Contacts?where=${where}`).catch(e => {
      if (e.status === 404) return null
      throw e
    })
    if (json?.Contacts?.length) return json.Contacts[0]
  }
  return null
}

async function upsertContact(xfetch, { name, email, phone, address }) {
  if (!name) throw new XeroError('Buyer name is required to create a Xero invoice.')
  const existing = await findContact(xfetch, { email, name })

  if (existing) {
    // Backfill the email on the matched contact if it's missing —
    // we need it for the invoice email step. Skip if Xero already
    // has one (don't overwrite — could be different and the
    // accountant's choice).
    const existingEmail = existing.EmailAddress || null
    if (!existingEmail && email) {
      const updated = await xfetch('/Contacts', {
        method: 'POST',
        body: { Contacts: [{ ContactID: existing.ContactID, EmailAddress: email }] },
      })
      return updated?.Contacts?.[0] || existing
    }
    return existing
  }

  // Create
  const payload = {
    Contacts: [{
      Name: name,
      ...(email ? { EmailAddress: email } : {}),
      ...(phone ? { Phones: [{ PhoneType: 'DEFAULT', PhoneNumber: phone }] } : {}),
      ...(address ? { Addresses: [{ AddressType: 'STREET', AddressLine1: address }] } : {}),
    }],
  }
  const json = await xfetch('/Contacts', { method: 'POST', body: payload })
  return json?.Contacts?.[0]
}

// ── Invoice payload ─────────────────────────────────────────────
function buildInvoicePayload(car, contactId, brandingThemeId, accountCode, taxType) {
  const exVat = Number(car.irish_sale_price_ex_vat || 0)
  const description = [
    'Tesla',
    car.make || '',
    car.model || '',
    car.vehicle_year ? `(${car.vehicle_year})` : '',
    car.uk_reg ? `· UK reg ${car.uk_reg}` : '',
    car.irish_reg ? `· IE reg ${car.irish_reg}` : '',
    car.vin ? `· VIN ${car.vin}` : '',
  ].filter(Boolean).join(' ').trim()

  const today = new Date()
  const dueDate = new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000)
  const fmt = d => d.toISOString().slice(0, 10)

  return {
    Invoices: [{
      Type: 'ACCREC',
      Contact: { ContactID: contactId },
      Date: fmt(today),
      DueDate: fmt(dueDate),
      LineAmountTypes: 'Exclusive',
      // CAR-INVOICE-REF — operator-requested format: "<model> - <Irish reg>"
      // e.g. "Model 3 - 221D37742". model can carry trailing
      // whitespace from import so trim it. Falls back to whatever
      // identifier is available if either part is missing.
      Reference: [car.model?.trim(), car.irish_reg].filter(Boolean).join(' - ')
        || car.uk_reg || car.vin || `Car ${car.id}`,
      CurrencyCode: 'EUR',
      Status: 'AUTHORISED',
      ...(brandingThemeId ? { BrandingThemeID: brandingThemeId } : {}),
      LineItems: [{
        Description: description || 'Tesla import — vehicle',
        Quantity: 1,
        UnitAmount: exVat,
        TaxType: taxType,
        AccountCode: accountCode,
      }],
      Url: process.env.NEXT_PUBLIC_APP_URL
        ? `${process.env.NEXT_PUBLIC_APP_URL}/cars/${car.id}`
        : undefined,
    }],
  }
}

// ── PDF storage ─────────────────────────────────────────────────
async function uploadInvoicePdf({ carId, invoiceNumber, bytes }) {
  const db = createServerClient()
  const safeNumber = String(invoiceNumber || 'unknown').replace(/[^A-Za-z0-9_-]/g, '_')
  const path = `cars/${carId}/xero-invoice-${safeNumber}.pdf`
  const { error } = await db.storage.from(STORAGE_BUCKET).upload(path, bytes, {
    contentType: 'application/pdf',
    upsert: true,
  })
  if (error) {
    // Persisting the PDF is best-effort — the invoice is already in
    // Xero. Log and let the caller decide how to surface it.
    logWarn('xero', `PDF upload failed for car ${carId}`, { err: error })
    return null
  }
  return path
}

// ── Public: issue ───────────────────────────────────────────────
export async function issueCarInvoice(car) {
  const errors = validateInvoiceFields(car)
  if (errors.length) {
    throw new XeroError(errors.join(' '))
  }

  const { xfetch, conn } = await withFreshToken(car.location_id)
  // CAR-SALES-ACCOUNT.1 — pull the location's configured car-sales
  // account code (mig 188) with env + '200' fallback for any
  // location that hasn't picked one yet. The Settings UI added in
  // CAR-SALES-ACCOUNT.1 makes the picker the canonical place to
  // set it.
  const accountCode = conn.car_sales_account_code
    || process.env.XERO_SALES_ACCOUNT_CODE
    || '200'

  // CAR-SALES-ACCOUNT.2 — look up the account's default tax_type
  // from the local xero_accounts cache (mig 186). Each Xero account
  // has its own valid tax_types — using a hardcoded 'OUTPUT2' broke
  // for accounts like Champ Fitness Ltd's '215 Sales of motor
  // vehicles' which uses TAX004. Falling back to OUTPUT2 if the
  // cache is empty (legacy path) or the picked code can't be
  // resolved.
  const db = createServerClient()
  const { data: accountRow } = await db
    .from('xero_accounts')
    .select('tax_type')
    .eq('location_id', car.location_id)
    .eq('code', accountCode)
    .maybeSingle()
  const taxType = accountRow?.tax_type || IE_OUTPUT_VAT

  const brandingThemeId = await resolveBrandingThemeId(xfetch)

  const contact = await upsertContact(xfetch, {
    name: car.buyer_name,
    email: car.buyer_email,
    phone: car.buyer_phone || null,
    address: car.buyer_address || null,
  })
  if (!contact?.ContactID) {
    throw new XeroError('Failed to resolve a Xero Contact for the buyer.')
  }

  const payload = buildInvoicePayload(car, contact.ContactID, brandingThemeId, accountCode, taxType)
  const created = await xfetch('/Invoices', { method: 'POST', body: payload })
  const inv = created?.Invoices?.[0]
  if (!inv?.InvoiceID) {
    throw new XeroError('Xero returned no invoice id.', { body: created })
  }

  // Email — empty body uses the contact's primary email + Xero's
  // default branded template. 204 No Content on success.
  let emailedAt = null
  let emailError = null
  try {
    await xfetch(`/Invoices/${inv.InvoiceID}/Email`, { method: 'POST', body: {} })
    emailedAt = new Date().toISOString()
  } catch (e) {
    emailError = e.message
  }

  // PDF — Accept: application/pdf returns the binary payload.
  let pdfPath = null
  try {
    const bytes = await xfetch(`/Invoices/${inv.InvoiceID}`, {
      headers: { Accept: 'application/pdf' },
      responseType: 'buffer',
    })
    pdfPath = await uploadInvoicePdf({
      carId: car.id,
      invoiceNumber: inv.InvoiceNumber,
      bytes,
    })
  } catch (e) {
    logWarn('xero', `PDF download failed for invoice ${inv.InvoiceNumber}`, { err: e })
  }

  const editorUrl = `https://go.xero.com/AccountsReceivable/Edit.aspx?InvoiceID=${inv.InvoiceID}`

  return {
    invoiceId: inv.InvoiceID,
    invoiceNumber: inv.InvoiceNumber,
    invoiceUrl: editorUrl,
    onlineInvoiceUrl: inv.Url || null,
    pdfPath,
    issuedAt: new Date().toISOString(),
    amount: Number(car.irish_sale_price_ex_vat),
    brandingThemeId: brandingThemeId || null,
    emailedAt,
    emailError,
    contactId: contact.ContactID,
    contactName: contact.Name,
    tenantId: conn.tenant_id,
  }
}

// ── Public: void ────────────────────────────────────────────────
//
// Voids the existing Xero invoice on the car. Caller is responsible
// for clearing the xero_invoice_* columns afterwards (and, for the
// reissue path, calling issueCarInvoice again).
export async function voidCarInvoice(car) {
  if (!car?.xero_invoice_id) throw new XeroError('No Xero invoice on this car to void.')
  if (!car.location_id) throw new XeroError('Car has no location_id.')

  const { xfetch } = await withFreshToken(car.location_id)
  const payload = {
    Invoices: [{
      InvoiceID: car.xero_invoice_id,
      Status: 'VOIDED',
    }],
  }
  // POST /Invoices with the InvoiceID + Status:VOIDED is Xero's
  // documented void path (PUT also works but POST mirrors create).
  await xfetch('/Invoices', { method: 'POST', body: payload })
  return { voidedInvoiceId: car.xero_invoice_id, voidedAt: new Date().toISOString() }
}
