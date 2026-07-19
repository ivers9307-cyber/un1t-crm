// SAAS-7 — DELETE must remove the attachment from the row's OWN bucket.
//
// mig 185 widened invoices_queue beyond supplier emails: rows carry
// attachment_bucket (contractor-invoices, fte-expense-receipts,
// car-documents, company-card-receipts, …). The attachment/extract
// routes already read per-row buckets; DELETE still hardcoded
// 'inbound-invoices', so deleting a rejected non-email row removed a
// (non-existent) path from the wrong bucket and orphaned the real
// object. These pin the bucket-selection helper.
import { describe, it, expect } from 'vitest'
import { removalBucket } from './route'

describe('removalBucket', () => {
  it("uses the row's own attachment_bucket when set", () => {
    expect(removalBucket({ attachment_bucket: 'contractor-invoices' })).toBe('contractor-invoices')
  })

  it('falls back to inbound-invoices for legacy pre-mig-185 rows', () => {
    expect(removalBucket({ attachment_bucket: null })).toBe('inbound-invoices')
    expect(removalBucket({})).toBe('inbound-invoices')
  })
})
