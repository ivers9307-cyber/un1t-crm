// Pure-helper tests for contractor-invoices.js. The lib module
// depends on shiftHours from payroll.js (already tested in
// payroll.test.js) and on a Supabase client passed in (skipped here
// — that's an integration concern). These tests cover the date math
// and option generators which are easy to get subtly wrong.

import { describe, it, expect } from 'vitest'
import {
  periodForMonth,
  recentMonthOptions,
  defaultMonthKey,
  periodLabel,
  buildPdfPath,
  isContractorPdfPath,
  RECEIPT_MIME_TYPES,
  mimeFromFilename,
  sniffReceiptMime,
} from './contractor-invoices'

describe('periodForMonth', () => {
  it('returns 1st → last day for May 2026 (31 days)', () => {
    const p = periodForMonth('2026-05')
    expect(p.period_start).toBe('2026-05-01')
    expect(p.period_end).toBe('2026-05-31')
    expect(p.label).toMatch(/May.*2026/)
  })
  it('returns 1st → last day for February 2024 (leap year)', () => {
    const p = periodForMonth('2024-02')
    expect(p.period_start).toBe('2024-02-01')
    expect(p.period_end).toBe('2024-02-29')
  })
  it('returns 1st → last day for February 2025 (non-leap)', () => {
    const p = periodForMonth('2025-02')
    expect(p.period_start).toBe('2025-02-01')
    expect(p.period_end).toBe('2025-02-28')
  })
  it('handles December (year boundary)', () => {
    const p = periodForMonth('2026-12')
    expect(p.period_start).toBe('2026-12-01')
    expect(p.period_end).toBe('2026-12-31')
  })
  it('throws on invalid month key', () => {
    expect(() => periodForMonth('2026-13')).toThrow()
    expect(() => periodForMonth('2026-1')).toThrow()
    expect(() => periodForMonth('not-a-date')).toThrow()
  })
})

describe('recentMonthOptions', () => {
  it('returns count entries newest-first', () => {
    const now = new Date(Date.UTC(2026, 4, 15)) // May 15
    const opts = recentMonthOptions(now, 4)
    expect(opts.length).toBe(4)
    expect(opts[0].key).toBe('2026-05')
    expect(opts[1].key).toBe('2026-04')
    expect(opts[2].key).toBe('2026-03')
    expect(opts[3].key).toBe('2026-02')
  })
  it('crosses year boundary correctly', () => {
    const now = new Date(Date.UTC(2026, 1, 10)) // Feb 10 2026
    const opts = recentMonthOptions(now, 3)
    expect(opts[0].key).toBe('2026-02')
    expect(opts[1].key).toBe('2026-01')
    expect(opts[2].key).toBe('2025-12')
  })
})

describe('defaultMonthKey', () => {
  it('returns the previous calendar month', () => {
    expect(defaultMonthKey(new Date(Date.UTC(2026, 4, 15)))).toBe('2026-04')
    expect(defaultMonthKey(new Date(Date.UTC(2026, 0, 5)))).toBe('2025-12')
  })
})

describe('periodLabel', () => {
  it('formats a period start as a long-month label', () => {
    expect(periodLabel('2026-05-01')).toMatch(/May.*2026/)
    expect(periodLabel('2024-02-01')).toMatch(/February.*2024/)
  })
})

describe('buildPdfPath', () => {
  it('namespaces by contractor + period + sanitises filename', () => {
    const p = buildPdfPath({
      contractorId: 'abc-123',
      periodStart: '2026-05-01',
      originalFilename: 'My Invoice (2026-05).pdf',
    })
    expect(p).toMatch(/^abc-123\/2026-05-01-[a-z0-9]{6}-My_Invoice__2026-05_\.pdf$/)
  })
  it('handles missing filename', () => {
    const p = buildPdfPath({
      contractorId: 'x',
      periodStart: '2026-05-01',
      originalFilename: null,
    })
    expect(p).toMatch(/^x\/2026-05-01-[a-z0-9]{6}-invoice\.pdf$/)
  })
})

describe('isContractorPdfPath', () => {
  const me = '0c5a1f0e-2d3b-4c5d-8e9f-a0b1c2d3e4f5'
  const other = '9b2e7c4a-1111-2222-3333-444455556666'

  it('accepts a buildPdfPath-shaped key in the contractor own folder', () => {
    const p = buildPdfPath({ contractorId: me, periodStart: '2026-05-01', originalFilename: 'May Invoice.pdf' })
    expect(isContractorPdfPath(p, me)).toBe(true)
  })

  it('rejects another contractor folder, traversal, nesting, and junk', () => {
    expect(isContractorPdfPath(`${other}/2026-05-01-abc123-invoice.pdf`, me)).toBe(false)
    expect(isContractorPdfPath(`${me}/../${other}/x.pdf`, me)).toBe(false)
    expect(isContractorPdfPath(`${me}/a/b.pdf`, me)).toBe(false)
    expect(isContractorPdfPath('', me)).toBe(false)
    expect(isContractorPdfPath(`${me}/`, me)).toBe(false)
    expect(isContractorPdfPath(`${me}/file with spaces.pdf`, me)).toBe(false)
  })

  it('accepts an image extension in the contractor own folder (SPEND.P1)', () => {
    const jpg = buildPdfPath({ contractorId: me, periodStart: '2026-05-01', originalFilename: 'receipt-1700000000000.jpg' })
    expect(isContractorPdfPath(jpg, me)).toBe(true)
    const heic = buildPdfPath({ contractorId: me, periodStart: '2026-05-01', originalFilename: 'IMG_0042.heic' })
    expect(isContractorPdfPath(heic, me)).toBe(true)
  })
})

describe('mimeFromFilename', () => {
  it('maps known extensions case-insensitively', () => {
    expect(mimeFromFilename('invoice.pdf')).toBe('application/pdf')
    expect(mimeFromFilename('receipt.JPG')).toBe('image/jpeg')
    expect(mimeFromFilename('a.jpeg')).toBe('image/jpeg')
    expect(mimeFromFilename('a.png')).toBe('image/png')
    expect(mimeFromFilename('a.WebP')).toBe('image/webp')
    expect(mimeFromFilename('IMG.heic')).toBe('image/heic')
    expect(mimeFromFilename('IMG.heif')).toBe('image/heif')
  })
  it('returns null for unknown or missing extensions', () => {
    expect(mimeFromFilename('notes.txt')).toBe(null)
    expect(mimeFromFilename('noextension')).toBe(null)
    expect(mimeFromFilename('')).toBe(null)
    expect(mimeFromFilename(null)).toBe(null)
  })
  it('only maps to types we actually accept', () => {
    for (const ext of ['pdf', 'jpg', 'jpeg', 'png', 'webp', 'heic', 'heif']) {
      expect(RECEIPT_MIME_TYPES).toContain(mimeFromFilename(`x.${ext}`))
    }
  })
})

describe('sniffReceiptMime', () => {
  const pad = (head) => Buffer.concat([Buffer.from(head), Buffer.alloc(16)])

  it('detects PDF by %PDF header', () => {
    expect(sniffReceiptMime(Buffer.from('%PDF-1.7\n%abc'))).toBe('application/pdf')
  })
  it('detects JPEG by FF D8 FF', () => {
    expect(sniffReceiptMime(pad([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
  })
  it('detects PNG by its 8-byte signature', () => {
    expect(sniffReceiptMime(pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('image/png')
  })
  it('detects WebP by RIFF....WEBP', () => {
    const buf = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x10, 0, 0, 0]), Buffer.from('WEBP'), Buffer.alloc(4)])
    expect(sniffReceiptMime(buf)).toBe('image/webp')
  })
  it('detects HEIC by the ftyp box brand', () => {
    const heic = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftyp'), Buffer.from('heic'), Buffer.alloc(4)])
    expect(sniffReceiptMime(heic)).toBe('image/heic')
    const heif = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftyp'), Buffer.from('mif1'), Buffer.alloc(4)])
    expect(sniffReceiptMime(heif)).toBe('image/heif')
  })
  it('returns null for unaccepted or too-short input', () => {
    expect(sniffReceiptMime(pad([0x47, 0x49, 0x46, 0x38]))).toBe(null) // GIF
    expect(sniffReceiptMime(Buffer.from('hello, plain text'))).toBe(null)
    expect(sniffReceiptMime(Buffer.from([0x25, 0x50]))).toBe(null) // too short
    expect(sniffReceiptMime(null)).toBe(null)
    expect(sniffReceiptMime(Buffer.alloc(0))).toBe(null)
  })
  it('only ever returns an accepted type or null', () => {
    const samples = [
      Buffer.from('%PDF-1.4 xxxx'),
      pad([0xff, 0xd8, 0xff, 0xe1]),
      pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    ]
    for (const s of samples) {
      const got = sniffReceiptMime(s)
      expect(got === null || RECEIPT_MIME_TYPES.includes(got)).toBe(true)
    }
  })
})
