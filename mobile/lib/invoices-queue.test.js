import { describe, it, expect } from 'vitest'
import {
  PENDING_STATUSES,
  MOBILE_EXTRACT_SYNC_CAP,
  isExtractable,
  splitExtractIds,
  xeroSupplierUnresolved,
  mergeExtractCounts,
  queueStatusMeta,
  SOURCE_LABEL,
} from './invoices-queue'

describe('isExtractable', () => {
  it('allows received + quality_approved rows', () => {
    expect(isExtractable({ status: 'received' })).toBe(true)
    expect(isExtractable({ status: 'quality_approved' })).toBe(true)
  })
  it('rejects post-extraction and terminal statuses', () => {
    for (const status of ['extracted', 'data_approved', 'forwarded', 'rejected']) {
      expect(isExtractable({ status })).toBe(false)
    }
  })
  it('rejects rows already claimed by the background analyser', () => {
    expect(isExtractable({ status: 'quality_approved', analysis_claimed_at: '2026-07-16T10:00:00Z' })).toBe(false)
    // queued-but-unclaimed can be re-sent (server clears stale flags)
    expect(isExtractable({ status: 'quality_approved', analysis_queued_at: '2026-07-16T10:00:00Z' })).toBe(true)
  })
  it('handles null/undefined', () => {
    expect(isExtractable(null)).toBe(false)
    expect(isExtractable(undefined)).toBe(false)
  })
})

describe('splitExtractIds', () => {
  it('splits at the mobile sync cap', () => {
    const ids = ['a', 'b', 'c', 'd', 'e']
    const { syncIds, queueIds } = splitExtractIds(ids)
    expect(syncIds).toEqual(ids.slice(0, MOBILE_EXTRACT_SYNC_CAP))
    expect(queueIds).toEqual(ids.slice(MOBILE_EXTRACT_SYNC_CAP))
  })
  it('queues nothing when under the cap', () => {
    expect(splitExtractIds(['a'])).toEqual({ syncIds: ['a'], queueIds: [] })
    expect(splitExtractIds([])).toEqual({ syncIds: [], queueIds: [] })
    expect(splitExtractIds(null)).toEqual({ syncIds: [], queueIds: [] })
  })
  it('honours an explicit cap', () => {
    expect(splitExtractIds(['a', 'b', 'c'], 1)).toEqual({ syncIds: ['a'], queueIds: ['b', 'c'] })
  })
})

describe('xeroSupplierUnresolved', () => {
  it('flags extracted/data_approved rows with no picked supplier', () => {
    expect(xeroSupplierUnresolved({ status: 'extracted', extracted_fields: {} })).toBe(true)
    expect(xeroSupplierUnresolved({ status: 'data_approved', extracted_fields: {} })).toBe(true)
    expect(xeroSupplierUnresolved({ status: 'extracted', extracted_fields: null })).toBe(true)
  })
  it('flags a to-be-created (kind new) supplier — not a matched Xero contact', () => {
    expect(xeroSupplierUnresolved({
      status: 'extracted',
      extracted_fields: { xero_contact_ref: { kind: 'new', name: 'Acme Ltd' } },
    })).toBe(true)
  })
  it('does not flag an existing Xero contact', () => {
    expect(xeroSupplierUnresolved({
      status: 'extracted',
      extracted_fields: { xero_contact_ref: { kind: 'existing', xero_contact_id: 'x1', name: 'Acme Ltd' } },
    })).toBe(false)
  })
  it('ignores pre-extraction and terminal rows (no fields to judge)', () => {
    for (const status of ['received', 'quality_approved', 'forwarded', 'rejected']) {
      expect(xeroSupplierUnresolved({ status, extracted_fields: {} })).toBe(false)
    }
    expect(xeroSupplierUnresolved(null)).toBe(false)
  })
})

describe('mergeExtractCounts', () => {
  it('maps sync ok → extracted and merges the queued leg', () => {
    expect(mergeExtractCounts(
      { counts: { ok: 2, failed: 1, skipped: 1 } },
      { counts: { queued: 4, skipped: 1 } },
    )).toEqual({ extracted: 2, failed: 1, skipped: 2, queued: 4 })
  })
  it('omits zero-count keys', () => {
    expect(mergeExtractCounts({ counts: { ok: 1 } }, null)).toEqual({ extracted: 1 })
    expect(mergeExtractCounts(null, null)).toEqual({})
  })
})

describe('queueStatusMeta', () => {
  it('mirrors the web status labels', () => {
    expect(queueStatusMeta({ status: 'received' })).toEqual({ label: 'Awaiting review', tone: 'amber' })
    expect(queueStatusMeta({ status: 'quality_approved' })).toEqual({ label: 'Awaiting extract', tone: 'blue' })
    expect(queueStatusMeta({ status: 'extracted' })).toEqual({ label: 'Awaiting data', tone: 'blue' })
    expect(queueStatusMeta({ status: 'data_approved' })).toEqual({ label: 'Awaiting send', tone: 'purple' })
  })
  it('surfaces the live queued/analysing sub-state for pre-extraction rows', () => {
    expect(queueStatusMeta({ status: 'quality_approved', analysis_queued_at: 't' }))
      .toEqual({ label: 'Queued', tone: 'amber' })
    expect(queueStatusMeta({ status: 'received', analysis_queued_at: 't', analysis_claimed_at: 't' }))
      .toEqual({ label: 'Analysing…', tone: 'blue' })
    // queue flags on a post-extraction row don't override the label
    expect(queueStatusMeta({ status: 'extracted', analysis_queued_at: 't' }))
      .toEqual({ label: 'Awaiting data', tone: 'blue' })
  })
  it('falls back to the raw status', () => {
    expect(queueStatusMeta({ status: 'weird' })).toEqual({ label: 'weird', tone: 'slate' })
    expect(queueStatusMeta(null)).toEqual({ label: '', tone: 'slate' })
  })
})

describe('constants', () => {
  it('pending set matches the bookkeeper action statuses', () => {
    expect(PENDING_STATUSES).toEqual(['received', 'quality_approved', 'extracted', 'data_approved'])
  })
  it('source labels cover the queue source types', () => {
    for (const k of ['supplier_email', 'contractor_invoice', 'fte_expense_item', 'card_receipt', 'car_document']) {
      expect(typeof SOURCE_LABEL[k]).toBe('string')
    }
  })
})
