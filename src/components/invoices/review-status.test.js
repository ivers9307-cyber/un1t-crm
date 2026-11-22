import { describe, it, expect } from 'vitest'
import {
  reasonChips,
  isReadyToSend,
  pillFor,
  notInvoiceText,
  unreadPanel,
  needsALookSkipped,
  isBeingRead,
  canRejectOne,
} from './review-status'

const P = '2026-11-22T09:00:00Z'

describe('reasonChips', () => {
  it('gives one chip per known reason, in display order', () => {
    const chips = reasonChips({ status: 'extracted', review_reasons: ['zero_total', 'new_supplier'] })
    expect(chips).toEqual([
      { key: 'new_supplier', label: 'New supplier', tone: 'amber' },
      { key: 'zero_total', label: 'Total is zero', tone: 'amber' },
    ])
  })

  it('folds the two duplicate reasons into one chip', () => {
    const chips = reasonChips({ status: 'extracted', review_reasons: ['duplicate_number', 'duplicate_file'] })
    expect(chips).toEqual([{ key: 'duplicate_file', label: 'Possible duplicate', tone: 'red' }])
  })

  it('colours the serious reasons red', () => {
    const chips = reasonChips({
      status: 'received',
      review_reasons: ['unreadable', 'duplicate_number', 'already_in_xero', 'credit_note', 'not_an_invoice', 'no_account'],
    })
    expect(chips.map((c) => [c.key, c.tone])).toEqual([
      ['unreadable', 'red'],
      ['duplicate_number', 'red'],
      ['already_in_xero', 'red'],
      ['credit_note', 'red'],
      ['not_an_invoice', 'red'],
      ['no_account', 'amber'],
    ])
  })

  it('ignores unknown reasons and repeats', () => {
    const chips = reasonChips({ status: 'quality_approved', review_reasons: ['nonsense', 'no_vat_rate', 'no_vat_rate'] })
    expect(chips).toEqual([{ key: 'no_vat_rate', label: 'No VAT rate', tone: 'amber' }])
  })

  it('shows Ready for a checked extracted row with no reasons', () => {
    const ready = [{ key: 'ready', label: 'Ready', tone: 'green' }]
    expect(reasonChips({ status: 'extracted', prepared_at: P, review_reasons: [] })).toEqual(ready)
    expect(reasonChips({ status: 'extracted', prepared_at: P, review_reasons: null })).toEqual(ready)
    expect(reasonChips({ status: 'extracted', prepared_at: P })).toEqual(ready)
  })

  it('shows no Ready for an extracted row that was never checked', () => {
    expect(reasonChips({ status: 'extracted', prepared_at: null, review_reasons: [] })).toEqual([])
    expect(reasonChips({ status: 'extracted' })).toEqual([])
  })

  it('shows reasons on an approved row, never Ready', () => {
    expect(reasonChips({ status: 'data_approved', prepared_at: P, review_reasons: ['no_account'] })).toEqual([
      { key: 'no_account', label: 'No account yet', tone: 'amber' },
    ])
    expect(reasonChips({ status: 'data_approved', prepared_at: P, review_reasons: [] })).toEqual([])
  })

  it('shows Ready when every reason is unknown', () => {
    expect(reasonChips({ status: 'extracted', prepared_at: P, review_reasons: ['nonsense'] })).toEqual([
      { key: 'ready', label: 'Ready', tone: 'green' },
    ])
  })

  it('shows nothing for an unread row with no reasons', () => {
    expect(reasonChips({ status: 'received', review_reasons: [] })).toEqual([])
    expect(reasonChips({ status: 'quality_approved', review_reasons: null })).toEqual([])
  })

  it('shows nothing for any other status, even with reasons', () => {
    for (const status of ['forwarded', 'rejected', 'not_invoice', 'something_new']) {
      expect(reasonChips({ status, review_reasons: ['new_supplier'] })).toEqual([])
    }
  })

  it('copes with no row', () => {
    expect(reasonChips(null)).toEqual([])
    expect(reasonChips(undefined)).toEqual([])
  })
})

describe('isReadyToSend', () => {
  const fields = { total: 10 }
  it('is true for an extracted or approved row with fields and no reasons', () => {
    expect(isReadyToSend({ status: 'extracted', extracted_fields: fields, review_reasons: [] })).toBe(true)
    expect(isReadyToSend({ status: 'data_approved', extracted_fields: fields, review_reasons: null })).toBe(true)
    expect(isReadyToSend({ status: 'extracted', extracted_fields: fields })).toBe(true)
  })
  it('keeps an old, never-checked extracted row sendable', () => {
    expect(isReadyToSend({ status: 'extracted', extracted_fields: fields, prepared_at: null, review_reasons: null })).toBe(true)
  })
  it('is false when the row has any reason', () => {
    expect(isReadyToSend({ status: 'extracted', extracted_fields: fields, review_reasons: ['no_account'] })).toBe(false)
  })
  it('is false without fields', () => {
    expect(isReadyToSend({ status: 'extracted', extracted_fields: null, review_reasons: [] })).toBe(false)
  })
  it('is false for other statuses', () => {
    for (const status of ['received', 'quality_approved', 'forwarded', 'rejected', 'not_invoice']) {
      expect(isReadyToSend({ status, extracted_fields: fields, review_reasons: [] })).toBe(false)
    }
  })
  it('is false for no row', () => {
    expect(isReadyToSend(null)).toBe(false)
  })
})

describe('pillFor', () => {
  it('labels a not-an-invoice row', () => {
    expect(pillFor({ status: 'not_invoice' })).toEqual({ label: 'Not an invoice', tone: 'neutral' })
  })
  it('shows Reading… for a queued unread row', () => {
    const t = '2026-11-22T10:00:00Z'
    expect(pillFor({ status: 'received', analysis_queued_at: t })).toEqual({ label: 'Reading…', tone: 'blue' })
    expect(pillFor({ status: 'quality_approved', analysis_queued_at: t })).toEqual({ label: 'Reading…', tone: 'blue' })
  })
  it('returns null otherwise', () => {
    expect(pillFor({ status: 'received', analysis_queued_at: null })).toBeNull()
    expect(pillFor({ status: 'quality_approved' })).toBeNull()
    expect(pillFor({ status: 'extracted', analysis_queued_at: '2026-11-22T10:00:00Z' })).toBeNull()
    expect(pillFor({ status: 'forwarded' })).toBeNull()
    expect(pillFor(null)).toBeNull()
  })
})

describe('notInvoiceText', () => {
  it('names a statement', () => {
    expect(notInvoiceText('document_type: statement')).toBe('This looks like a statement, not a bill')
  })
  it('names any other document', () => {
    expect(notInvoiceText('document_type: other')).toBe('This does not look like an invoice')
  })
  it('leaves every other reason to the existing line', () => {
    expect(notInvoiceText('no_attachment')).toBeNull()
    expect(notInvoiceText('unsupported_type: text/html')).toBeNull()
    expect(notInvoiceText('attachment_not_received: too_large')).toBeNull()
    expect(notInvoiceText(null)).toBeNull()
    expect(notInvoiceText(undefined)).toBeNull()
  })
})

describe('unreadPanel', () => {
  it('offers Read again for an unreadable row', () => {
    for (const status of ['received', 'quality_approved']) {
      expect(unreadPanel({ status, review_reasons: ['unreadable'], analysis_queued_at: null })).toEqual({
        title: 'This could not be read',
        primary: 'read_again',
        secondary: 'reject',
      })
    }
  })
  it('offers Reject first for a file already in the queue', () => {
    expect(unreadPanel({ status: 'received', review_reasons: ['duplicate_file'] })).toEqual({
      title: 'This file is already in the queue',
      primary: 'reject',
      secondary: 'read_anyway',
    })
  })
  it('prefers unreadable when both are present', () => {
    expect(unreadPanel({ status: 'received', review_reasons: ['duplicate_file', 'unreadable'] })?.primary).toBe('read_again')
  })
  it('is null for a row from before the change (no reasons)', () => {
    expect(unreadPanel({ status: 'received', review_reasons: [] })).toBeNull()
    expect(unreadPanel({ status: 'quality_approved', review_reasons: null })).toBeNull()
    expect(unreadPanel({ status: 'received', review_reasons: ['new_supplier'] })).toBeNull()
  })
  it('is null while the row is queued to be read', () => {
    expect(unreadPanel({ status: 'received', review_reasons: ['unreadable'], analysis_queued_at: '2026-11-22T10:00:00Z' })).toBeNull()
  })
  it('is null for other statuses', () => {
    for (const status of ['extracted', 'data_approved', 'not_invoice', 'rejected']) {
      expect(unreadPanel({ status, review_reasons: ['unreadable'] })).toBeNull()
    }
    expect(unreadPanel(null)).toBeNull()
  })
})

describe('needsALookSkipped', () => {
  it('counts rows the send skipped because they need a look', () => {
    expect(needsALookSkipped([
      { id: 'a', outcome: 'skipped', reason: 'needs_a_look' },
      { id: 'b', outcome: 'skipped', reason: 'no_vat_rate' },
      { id: 'c', outcome: 'ok' },
      { id: 'd', outcome: 'skipped', reason: 'needs_a_look' },
    ])).toBe(2)
  })
  it('is 0 for no results', () => {
    expect(needsALookSkipped(undefined)).toBe(0)
    expect(needsALookSkipped([])).toBe(0)
  })
})

describe('isBeingRead', () => {
  it('is true for a queued unread row', () => {
    expect(isBeingRead({ status: 'received', analysis_queued_at: P })).toBe(true)
    expect(isBeingRead({ status: 'quality_approved', analysis_queued_at: P })).toBe(true)
  })
  it('is false otherwise', () => {
    expect(isBeingRead({ status: 'received', analysis_queued_at: null })).toBe(false)
    expect(isBeingRead({ status: 'extracted', analysis_queued_at: P })).toBe(false)
    expect(isBeingRead({ status: 'not_invoice' })).toBe(false)
    expect(isBeingRead(null)).toBe(false)
  })
})

describe('canRejectOne', () => {
  it('allows any received row', () => {
    expect(canRejectOne({ status: 'received', review_reasons: [] })).toBe(true)
  })
  it('allows a quality_approved row only when unreadable or a duplicate file', () => {
    expect(canRejectOne({ status: 'quality_approved', review_reasons: ['unreadable'] })).toBe(true)
    expect(canRejectOne({ status: 'quality_approved', review_reasons: ['duplicate_file'] })).toBe(true)
    expect(canRejectOne({ status: 'quality_approved', review_reasons: ['duplicate_number'] })).toBe(false)
    expect(canRejectOne({ status: 'quality_approved', review_reasons: null })).toBe(false)
  })
  it('is false for other statuses', () => {
    expect(canRejectOne({ status: 'extracted', review_reasons: ['unreadable'] })).toBe(false)
    expect(canRejectOne(null)).toBe(false)
  })
})
