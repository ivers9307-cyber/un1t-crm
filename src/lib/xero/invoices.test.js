// CAR-INVOICE-VALIDATION — validateInvoiceFields coverage.
//
// Locks the operator-requested completeness gate: every car
// detail field must be filled before an invoice can issue. 0 is
// a valid numeric value; blank/null is not. IE ex-VAT sale price
// is the strict exception — must be > 0.

import { describe, it, expect } from 'vitest'
import {
  validateInvoiceFields,
  parseAddressForXero,
  buildInvoicePayload,
} from './invoices'

// A fully-populated car that should pass with zero errors. Every
// test below starts from this and removes / blanks one field.
function completeCar(overrides = {}) {
  return {
    location_id: 'loc1',
    buyer_name: 'Platin Car Sales',
    buyer_email: 'buyer@example.com',
    uk_reg: 'NL22 MWM',
    irish_reg: '221D37742',
    vin: 'LRW3F7FS5NC505371',
    make: 'Tesla',
    model: 'Model 3',
    vehicle_year: 2022,
    uk_purchase_price_ex_vat: 11348.67,
    uk_vat: 0,
    irish_sale_price_ex_vat: 16666.67,
    irish_sale_price_inc_vat: 20500,
    uk_transporter_cost: 400,
    ferry_cost: 225,
    import_customs_cost: 1300,
    nct_cost: 0,
    additional_costs: 0,
    ...overrides,
  }
}

describe('validateInvoiceFields', () => {
  it('returns no errors for a fully-populated car', () => {
    expect(validateInvoiceFields(completeCar())).toEqual([])
  })

  it('accepts 0 for numeric cost/price fields (margin-scheme / no-NCT cars)', () => {
    const car = completeCar({
      uk_vat: 0, nct_cost: 0, additional_costs: 0,
      uk_transporter_cost: 0, ferry_cost: 0, import_customs_cost: 0,
    })
    expect(validateInvoiceFields(car)).toEqual([])
  })

  it('flags every missing vehicle text field', () => {
    const car = completeCar({
      uk_reg: '', irish_reg: null, vin: '   ', make: '', model: undefined,
    })
    const errs = validateInvoiceFields(car)
    expect(errs).toEqual(expect.arrayContaining([
      'UK reg is required.',
      'Irish reg is required.',
      'VIN is required.',
      'Make is required.',
      'Model is required.',
    ]))
  })

  it('flags blank numeric fields but not zero ones', () => {
    const car = completeCar({
      uk_vat: null,            // blank → error
      nct_cost: 0,             // zero → OK
      ferry_cost: undefined,   // blank → error
      additional_costs: 0,     // zero → OK
    })
    const errs = validateInvoiceFields(car)
    expect(errs).toContain('UK VAT is required.')
    expect(errs).toContain('Ferry cost is required.')
    expect(errs).not.toContain('NCT cost is required.')
    expect(errs).not.toContain('Commission payout is required.')
  })

  it('flags a non-numeric value in a numeric field', () => {
    const car = completeCar({ import_customs_cost: 'lots' })
    expect(validateInvoiceFields(car)).toContain('Import customs cost is required.')
  })

  it('requires IE ex-VAT sale price to be greater than zero', () => {
    expect(validateInvoiceFields(completeCar({ irish_sale_price_ex_vat: 0 })))
      .toContain('IE ex-VAT sale price must be set and greater than zero.')
    expect(validateInvoiceFields(completeCar({ irish_sale_price_ex_vat: null })))
      .toContain('IE ex-VAT sale price must be set and greater than zero.')
    expect(validateInvoiceFields(completeCar({ irish_sale_price_ex_vat: -5 })))
      .toContain('IE ex-VAT sale price must be set and greater than zero.')
  })

  it('still flags missing buyer + location', () => {
    const car = completeCar({ buyer_name: '', buyer_email: null, location_id: null })
    const errs = validateInvoiceFields(car)
    expect(errs).toContain('Buyer name is required.')
    expect(errs).toContain('Buyer email is required (used to email the invoice).')
    expect(errs).toContain('Car has no location assigned.')
  })

  it('handles a null car defensively', () => {
    expect(validateInvoiceFields(null)).toEqual(['No car provided.'])
  })
})

// CCF-INVOICE-FIX — the buyer address must reach Xero as a structured
// billing (POBOX) address, not a single dumped string.
describe('parseAddressForXero', () => {
  it('returns null for blank input', () => {
    expect(parseAddressForXero(null)).toBeNull()
    expect(parseAddressForXero(undefined)).toBeNull()
    expect(parseAddressForXero('')).toBeNull()
    expect(parseAddressForXero('   \n  ')).toBeNull()
  })

  it('maps a five-line address positionally and flags it as billing (POBOX)', () => {
    const addr = parseAddressForXero('12 Main Street\nRathmines\nDublin\nD06 XY12\nIreland')
    expect(addr).toEqual({
      AddressType: 'POBOX',
      AddressLine1: '12 Main Street',
      AddressLine2: 'Rathmines',
      City: 'Dublin',
      PostalCode: 'D06 XY12',
      Country: 'Ireland',
    })
  })

  it('splits a comma-joined address the same way (Xero contact-search prefill shape)', () => {
    const addr = parseAddressForXero('12 Main Street, Rathmines, Dublin, D06 XY12, Ireland')
    expect(addr).toEqual({
      AddressType: 'POBOX',
      AddressLine1: '12 Main Street',
      AddressLine2: 'Rathmines',
      City: 'Dublin',
      PostalCode: 'D06 XY12',
      Country: 'Ireland',
    })
  })

  it('leaves trailing fields unset when there are fewer than five parts', () => {
    const addr = parseAddressForXero('12 Main Street\nRathmines\nDublin')
    expect(addr).toEqual({
      AddressType: 'POBOX',
      AddressLine1: '12 Main Street',
      AddressLine2: 'Rathmines',
      City: 'Dublin',
    })
    expect(addr).not.toHaveProperty('PostalCode')
    expect(addr).not.toHaveProperty('Country')
  })

  it('handles a single-line address', () => {
    expect(parseAddressForXero('12 Main Street')).toEqual({
      AddressType: 'POBOX',
      AddressLine1: '12 Main Street',
    })
  })

  it('folds parts past the fifth into AddressLine2 so nothing is dropped', () => {
    const addr = parseAddressForXero('Apt 4\nBlock B\nThe Mews\nDublin\nD02 AB12\nIreland')
    expect(addr.AddressLine1).toBe('Apt 4')
    expect(addr.AddressLine2).toBe('Block B, Ireland')
    expect(addr.City).toBe('The Mews')
    expect(addr.PostalCode).toBe('Dublin')
    expect(addr.Country).toBe('D02 AB12')
  })

  it('trims whitespace and drops empty segments', () => {
    const addr = parseAddressForXero('  12 Main Street  ,, \n  Dublin  \n')
    expect(addr).toEqual({
      AddressType: 'POBOX',
      AddressLine1: '12 Main Street',
      AddressLine2: 'Dublin',
    })
  })
})

describe('buildInvoicePayload — line description', () => {
  it('omits the UK reg from the customer-facing description', () => {
    const payload = buildInvoicePayload(completeCar(), 'CID', null, '200', 'OUTPUT2')
    const desc = payload.Invoices[0].LineItems[0].Description
    expect(desc).not.toMatch(/UK reg/i)
    expect(desc).not.toContain('NL22 MWM')   // the completeCar uk_reg value
  })

  it('still carries the make, model, year, Irish reg and VIN', () => {
    const payload = buildInvoicePayload(completeCar(), 'CID', null, '200', 'OUTPUT2')
    const desc = payload.Invoices[0].LineItems[0].Description
    expect(desc).toContain('Model 3')
    expect(desc).toContain('(2022)')
    expect(desc).toContain('IE reg 221D37742')
    expect(desc).toContain('VIN LRW3F7FS5NC505371')
  })

  it('does not double-print the make (no hard-coded "Tesla" prefix)', () => {
    const desc = buildInvoicePayload(completeCar(), 'CID', null, '200', 'OUTPUT2').Invoices[0].LineItems[0].Description
    expect(desc).not.toMatch(/Tesla\s+Tesla/)          // the old bug: literal 'Tesla' + car.make 'Tesla'
    expect(desc.match(/Tesla/g) || []).toHaveLength(1)  // the make appears exactly once
    expect(desc.startsWith('Tesla Model 3')).toBe(true)
  })

  it('uses the actual make for a non-Tesla vehicle', () => {
    const desc = buildInvoicePayload(completeCar({ make: 'BMW', model: '3 Series' }), 'CID', null, '200', 'OUTPUT2').Invoices[0].LineItems[0].Description
    expect(desc).toContain('BMW 3 Series')
    expect(desc).not.toContain('Tesla')
  })

  it('falls back to a make-neutral description when the vehicle fields are all blank', () => {
    const blank = completeCar({ make: '', model: '', vehicle_year: null, irish_reg: '', vin: '' })
    const desc = buildInvoicePayload(blank, 'CID', null, '200', 'OUTPUT2').Invoices[0].LineItems[0].Description
    expect(desc).toBe('Imported vehicle')
  })
})
