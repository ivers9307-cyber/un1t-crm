// CARDOCBUCKET.1 — the one list the car-documents route, bucket (mig 687)
// and picker share.
import { describe, it, expect } from 'vitest'
import {
  isUnlabelledCarDocumentType,
  CAR_DOCUMENT_MIME_TYPES, CAR_DOCUMENT_MAX_BYTES, CAR_DOCUMENT_ACCEPT,
  CAR_DOCUMENT_TYPES_LABEL, resolveCarDocumentType, sniffCarDocumentHeif,
} from './car-document-media.js'

// An ISO-BMFF 'ftyp' box: size, 'ftyp', major brand, minor version, compatible brands.
function ftyp(major, ...compatible) {
  const size = 16 + 4 * compatible.length
  const b = Buffer.alloc(size + 8)
  b.writeUInt32BE(size, 0)
  b.write('ftyp', 4, 'ascii')
  b.write(major, 8, 'ascii')
  compatible.forEach((c, i) => b.write(c, 16 + 4 * i, 'ascii'))
  b.write('meta', size + 4, 'ascii')
  return b
}

describe('car-document-media', () => {
  it('is the seven types the car pages and the invoice pipeline can read, and 25 MiB', () => {
    expect([...CAR_DOCUMENT_MIME_TYPES]).toEqual([
      'application/pdf', 'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic', 'image/heif',
    ])
    expect(CAR_DOCUMENT_MAX_BYTES).toBe(26214400)
    expect(CAR_DOCUMENT_ACCEPT).toBe(CAR_DOCUMENT_MIME_TYPES.join(','))
    expect(CAR_DOCUMENT_TYPES_LABEL).toBe('PDF, JPEG, PNG, GIF, WebP or HEIC')
    expect(Object.isFrozen(CAR_DOCUMENT_MIME_TYPES)).toBe(true)
  })

  it('keeps a declared type on the list (case and spaces ignored)', () => {
    expect(resolveCarDocumentType('application/pdf', null)).toBe('application/pdf')
    expect(resolveCarDocumentType(' Image/HEIC ', null)).toBe('image/heic')
    // the declared type wins over the bytes: content sniffing a labelled file is out of scope (D6)
    expect(resolveCarDocumentType('image/png', 'application/pdf')).toBe('image/png')
  })

  it('judges an unlabelled file by its bytes', () => {
    expect(resolveCarDocumentType('', 'application/pdf')).toBe('application/pdf')
    expect(resolveCarDocumentType(undefined, 'image/jpeg')).toBe('image/jpeg')
    expect(resolveCarDocumentType('application/octet-stream', 'image/webp')).toBe('image/webp')
    expect(resolveCarDocumentType('', null)).toBeNull()
    expect(resolveCarDocumentType('application/octet-stream', null)).toBeNull()
  })

  it('refuses every other declared type, whatever the bytes say', () => {
    for (const t of ['application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'image/svg+xml', 'text/html', 'image/tiff', 'image/avif', 'application/zip', 'text/plain']) {
      expect(resolveCarDocumentType(t, 'application/pdf'), t).toBeNull()
    }
  })

  it('maps the legacy aliases some clients still send onto the listed type', () => {
    expect(resolveCarDocumentType('image/jpg', null)).toBe('image/jpeg')
    expect(resolveCarDocumentType('image/pjpeg', null)).toBe('image/jpeg')
    expect(resolveCarDocumentType('image/x-png', null)).toBe('image/png')
    expect(resolveCarDocumentType('application/x-pdf', null)).toBe('application/pdf')
    expect(resolveCarDocumentType('Image/JPG', 'image/jpeg')).toBe('image/jpeg')
    expect(resolveCarDocumentType('application/pdf; charset=binary', null)).toBe('application/pdf')
  })

  it('every value it returns is one of the seven (what the bucket accepts)', () => {
    const declared = ['', 'application/octet-stream', 'image/jpg', 'image/pjpeg', 'image/x-png', 'application/x-pdf',
      ...CAR_DOCUMENT_MIME_TYPES, 'text/html', 'image/avif']
    const sniffed = [null, 'image/png', 'image/heic', 'image/heif', 'text/html']
    for (const d of declared) for (const s of sniffed) {
      const r = resolveCarDocumentType(d, s)
      if (r !== null) expect(CAR_DOCUMENT_MIME_TYPES, `${d} + ${s}`).toContain(r)
    }
  })
})

describe('sniffCarDocumentHeif — an unlabelled HEIC (Chrome/Firefox on Windows send no type)', () => {
  it('reads the iPhone HEIC brands as image/heic', () => {
    expect(sniffCarDocumentHeif(ftyp('heic', 'mif1', 'heic'))).toBe('image/heic')
    for (const brand of ['heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs']) {
      expect(sniffCarDocumentHeif(ftyp(brand, 'mif1')), brand).toBe('image/heic')
    }
  })

  it('reads the generic HEIF brands as image/heif', () => {
    expect(sniffCarDocumentHeif(ftyp('mif1', 'heic'))).toBe('image/heif')
    expect(sniffCarDocumentHeif(ftyp('msf1', 'hevc'))).toBe('image/heif')
  })

  it('does not call AVIF (also mif1-based) or other ISO-BMFF files HEIF', () => {
    expect(sniffCarDocumentHeif(ftyp('avif', 'mif1', 'miaf'))).toBeNull()
    expect(sniffCarDocumentHeif(ftyp('mif1', 'avif', 'miaf'))).toBeNull()
    expect(sniffCarDocumentHeif(ftyp('isom', 'iso2', 'mp41'))).toBeNull() // an MP4
    expect(sniffCarDocumentHeif(ftyp('qt  '))).toBeNull() // a .mov
  })

  it('returns null for short, empty or non-ftyp bytes', () => {
    expect(sniffCarDocumentHeif(null)).toBeNull()
    expect(sniffCarDocumentHeif(Buffer.alloc(0))).toBeNull()
    expect(sniffCarDocumentHeif(Buffer.from('....ftyp'))).toBeNull()
    expect(sniffCarDocumentHeif(Buffer.from('%PDF-1.7 ftypheic'))).toBeNull()
  })
})

describe('isUnlabelledCarDocumentType (CARDOCUPLOAD.1)', () => {
  it('is true for no type and application/octet-stream only', () => {
    for (const t of ['', null, undefined, 'application/octet-stream', ' Application/Octet-Stream; x=1']) {
      expect(isUnlabelledCarDocumentType(t), String(t)).toBe(true)
    }
    for (const t of ['application/pdf', 'image/jpg', 'text/html']) expect(isUnlabelledCarDocumentType(t), t).toBe(false)
  })
})
