// CARDOCBUCKET.1 — the one list the car-documents route, bucket (mig 687)
// and picker share.
import { describe, it, expect } from 'vitest'
import {
  CAR_DOCUMENT_MIME_TYPES, CAR_DOCUMENT_MAX_BYTES, CAR_DOCUMENT_ACCEPT,
  CAR_DOCUMENT_TYPES_LABEL, resolveCarDocumentType,
} from './car-document-media.js'

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
})
