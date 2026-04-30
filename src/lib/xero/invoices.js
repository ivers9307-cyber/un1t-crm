// Customer invoice push for completed cars.
//
// Flow:
//   1. Resolve buyer to a Xero Contact — find by email if present,
//      else by name. Create a new contact if neither matches.
//   2. Build the Invoice payload — single line item priced at IE
//      ex-VAT, with tax type OUTPUT2 (Irish 23% standard rate). The
//      sale currency is EUR. Reference + LineItem.Description tie the
//      invoice back to the car for human cross-checking.
//   3. POST to /Invoices, capture the returned InvoiceID, InvoiceNumber
//      and OnlineInvoiceUrl, write them onto the car row.
//
// Side effects: also flips xero_invoice_issued_at — the existing
// completion gate in completionGaps() flips green automatically.

import { withFreshToken, XeroError } from './client'

// IE 23% VAT, output side. Xero's tax type code; valid for cars sold
// to consumers from a Republic of Ireland tenant. If the seller is
// VAT-registered in another jurisdiction this would need to change.
const IE_OUTPUT_VAT = 'OUTPUT2'

function escapeWhereString(str) {
  // Xero's WHERE param is single-quoted. Escape internal quotes.
  return String(str).replace(/'/g, "''")
}

async function findContact(xfetch, { email, name }) {
  // Prefer email match — unique enough for our buyers. Fall back to
  // exact-name match (case-insensitive on Xero's side).
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
  if (existing) return existing

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

// Map a car row into a Xero Invoice payload. Sale currency is EUR.
// Description includes UK reg + VIN so the buyer / accountant can
// cross-reference the deal.
function buildInvoicePayload(car, contactId) {
  const exVat = Number(car.irish_sale_price_ex_vat || 0)
  if (!exVat) {
    throw new XeroError('IE ex-VAT must be set before issuing a Xero invoice.')
  }

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
  const dueDate = new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000) // Net 7
  const fmt = d => d.toISOString().slice(0, 10)

  return {
    Invoices: [{
      Type: 'ACCREC',                           // Accounts Receivable
      Contact: { ContactID: contactId },
      Date: fmt(today),
      DueDate: fmt(dueDate),
      LineAmountTypes: 'Exclusive',             // amounts excl VAT
      Reference: car.uk_reg || car.vin || `Car ${car.id}`,
      CurrencyCode: 'EUR',
      Status: 'AUTHORISED',                     // ready to send (not draft)
      LineItems: [{
        Description: description || 'Tesla import — vehicle',
        Quantity: 1,
        UnitAmount: exVat,
        TaxType: IE_OUTPUT_VAT,
        AccountCode: process.env.XERO_SALES_ACCOUNT_CODE || '200', // 200 = Sales (default chart)
      }],
      Url: process.env.NEXT_PUBLIC_APP_URL
        ? `${process.env.NEXT_PUBLIC_APP_URL}/cars/${car.id}`
        : undefined,
    }],
  }
}

/**
 * Issue a customer sales invoice for the given car.
 * @param {object} car   Car row (must include buyer_*, irish_sale_price_ex_vat)
 * @returns {{ invoiceId, invoiceNumber, invoiceUrl, issuedAt }}
 */
export async function issueCarInvoice(car) {
  if (!car) throw new XeroError('No car provided.')
  if (!car.location_id) throw new XeroError('Car has no location_id.')
  if (!car.buyer_name) throw new XeroError('Buyer name is required before issuing an invoice.')

  const { xfetch, conn } = await withFreshToken(car.location_id)

  const contact = await upsertContact(xfetch, {
    name: car.buyer_name,
    email: car.buyer_email || null,
    phone: car.buyer_phone || null,
    address: car.buyer_address || null,
  })
  if (!contact?.ContactID) {
    throw new XeroError('Failed to resolve a Xero Contact for the buyer.')
  }

  const payload = buildInvoicePayload(car, contact.ContactID)
  const json = await xfetch('/Invoices', { method: 'POST', body: payload })
  const inv = json?.Invoices?.[0]
  if (!inv?.InvoiceID) {
    throw new XeroError('Xero returned no invoice id.', { body: json })
  }

  // Build a deep-link to the invoice in Xero. There is no public
  // /Invoices/<id> URL we can construct from REST output that goes to
  // the org's web UI directly — the OnlineInvoiceUrl Xero returns is
  // the customer-facing pay-invoice link, which is what we want for
  // emailing the buyer. We store both shapes so the operator can pick.
  const onlineInvoiceUrl = inv.Url || null
  const editorUrl = `https://go.xero.com/AccountsReceivable/Edit.aspx?InvoiceID=${inv.InvoiceID}`

  return {
    invoiceId: inv.InvoiceID,
    invoiceNumber: inv.InvoiceNumber,
    invoiceUrl: editorUrl,
    onlineInvoiceUrl,
    contactId: contact.ContactID,
    contactName: contact.Name,
    tenantId: conn.tenant_id,
    issuedAt: new Date().toISOString(),
  }
}
