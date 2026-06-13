import { describe, it, expect } from 'vitest'
import {
  buildReceiptPath,
  isCardReceiptPath,
  RECEIPT_MIME_TYPES,
  sniffReceiptMime,
  CARD_RECEIPTS_BUCKET,
} from './card-receipts'

describe('buildReceiptPath', () => {
  it('namespaces by submitter + date + sanitises filename', () => {
    const p = buildReceiptPath({
      submitterId: 'abc-123',
      purchaseDate: '2026-06-13',
      originalFilename: 'Tesco Receipt (June).jpg',
    })
    expect(p).toMatch(/^abc-123\/2026-06-13-[a-z0-9]{6}-Tesco_Receipt__June_\.jpg$/)
  })
  it('handles a missing filename', () => {
    const p = buildReceiptPath({ submitterId: 'x', purchaseDate: '2026-06-13', originalFilename: null })
    expect(p).toMatch(/^x\/2026-06-13-[a-z0-9]{6}-receipt$/)
  })
})

describe('isCardReceiptPath', () => {
  const me = '0c5a1f0e-2d3b-4c5d-8e9f-a0b1c2d3e4f5'
  const other = '9b2e7c4a-1111-2222-3333-444455556666'

  it('accepts a buildReceiptPath-shaped key in the submitter own folder', () => {
    const pdf = buildReceiptPath({ submitterId: me, purchaseDate: '2026-06-13', originalFilename: 'receipt.pdf' })
    expect(isCardReceiptPath(pdf, me)).toBe(true)
    const jpg = buildReceiptPath({ submitterId: me, purchaseDate: '2026-06-13', originalFilename: 'receipt-1700000000000.jpg' })
    expect(isCardReceiptPath(jpg, me)).toBe(true)
  })

  it('rejects another submitter folder, traversal, nesting, and junk', () => {
    expect(isCardReceiptPath(`${other}/2026-06-13-abc123-receipt.jpg`, me)).toBe(false)
    expect(isCardReceiptPath(`${me}/../${other}/x.jpg`, me)).toBe(false)
    expect(isCardReceiptPath(`${me}/a/b.jpg`, me)).toBe(false)
    expect(isCardReceiptPath('', me)).toBe(false)
    expect(isCardReceiptPath(`${me}/`, me)).toBe(false)
    expect(isCardReceiptPath(`${me}/file with spaces.jpg`, me)).toBe(false)
  })
})

describe('re-exported receipt MIME helpers', () => {
  it('exposes the shared accepted types + bucket name', () => {
    expect(RECEIPT_MIME_TYPES).toContain('application/pdf')
    expect(RECEIPT_MIME_TYPES).toContain('image/jpeg')
    expect(CARD_RECEIPTS_BUCKET).toBe('company-card-receipts')
  })
  it('sniffs receipt bytes via the shared detector', () => {
    expect(sniffReceiptMime(Buffer.from('%PDF-1.7\n%abc'))).toBe('application/pdf')
    expect(sniffReceiptMime(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16)]))).toBe('image/jpeg')
    expect(sniffReceiptMime(Buffer.from('not a receipt'))).toBe(null)
  })
})
