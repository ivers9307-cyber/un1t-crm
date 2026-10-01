// CARDOCUPLOAD.1 (C124) — the car-document signed-upload slot rules.
import { describe, it, expect } from 'vitest'
import {
  carDocumentExtension, buildCarDocumentUploadPath, isCarDocumentUploadPath, checkCarDocumentSize,
  CAR_DOCUMENT_SIZE_ERROR, CAR_DOCUMENT_EMPTY_ERROR, CAR_DOCUMENT_HEAD_BYTES,
} from './car-document-upload.js'
import { CAR_DOCUMENT_MIME_TYPES, CAR_DOCUMENT_MAX_BYTES } from './car-document-media.js'

const CAR = 'c0000000-0000-0000-0000-000000000001'
const ID = '0f8fad5b-d9cb-469f-a165-70867728950e'

describe('carDocumentExtension', () => {
  it('names every listed type', () => {
    for (const t of CAR_DOCUMENT_MIME_TYPES) expect(carDocumentExtension(t), t).toMatch(/^[a-z]{3,4}$/)
    expect(carDocumentExtension('application/pdf')).toBe('pdf')
    expect(carDocumentExtension('image/jpeg')).toBe('jpg')
    expect(carDocumentExtension('image/heic')).toBe('heic')
  })
  it('has no extension for a type off the list', () => {
    expect(carDocumentExtension('text/plain')).toBeNull()
    expect(carDocumentExtension('')).toBeNull()
  })
})

describe('buildCarDocumentUploadPath', () => {
  it("is the multipart route's <car>/<doc_type>/ folder, a uuid and the type's extension", () => {
    expect(buildCarDocumentUploadPath({ carId: CAR, docType: 'nct_invoice', contentType: 'application/pdf', id: ID }))
      .toBe(`${CAR}/nct_invoice/${ID}.pdf`)
  })
})

describe('isCarDocumentUploadPath', () => {
  const good = `${CAR}/other/${ID}.pdf`
  it('accepts a slot minted for this car and doc type', () => {
    expect(isCarDocumentUploadPath(good, CAR, 'other')).toBe(true)
    expect(isCarDocumentUploadPath(`${CAR}/other/${ID}.heic`, CAR, 'other')).toBe(true)
  })
  it('refuses another car, another doc type, traversal, a caller-chosen name or extension', () => {
    expect(isCarDocumentUploadPath(good, 'c0000000-0000-0000-0000-000000000002', 'other')).toBe(false)
    expect(isCarDocumentUploadPath(good, CAR, 'nct_invoice')).toBe(false)
    expect(isCarDocumentUploadPath(`${CAR}/other/../x/${ID}.pdf`, CAR, 'other')).toBe(false)
    expect(isCarDocumentUploadPath(`${CAR}/other/invoice.pdf`, CAR, 'other')).toBe(false)
    expect(isCarDocumentUploadPath(`${CAR}/other/${ID}.exe`, CAR, 'other')).toBe(false)
    expect(isCarDocumentUploadPath(`${CAR}/other/${ID}.pdf/x`, CAR, 'other')).toBe(false)
    expect(isCarDocumentUploadPath(`cars/${CAR}/invoice.pdf`, CAR, 'other')).toBe(false)
    expect(isCarDocumentUploadPath(null, CAR, 'other')).toBe(false)
    expect(isCarDocumentUploadPath(good, '', 'other')).toBe(false)
  })
})

describe('checkCarDocumentSize', () => {
  it('passes 1 byte up to the bucket limit', () => {
    expect(checkCarDocumentSize(1)).toBeNull()
    expect(checkCarDocumentSize(CAR_DOCUMENT_MAX_BYTES)).toBeNull()
  })
  it('refuses over the limit, empty and nonsense', () => {
    expect(checkCarDocumentSize(CAR_DOCUMENT_MAX_BYTES + 1)).toBe(CAR_DOCUMENT_SIZE_ERROR)
    expect(checkCarDocumentSize(0)).toBe(CAR_DOCUMENT_EMPTY_ERROR)
    expect(checkCarDocumentSize(undefined)).toBe(CAR_DOCUMENT_EMPTY_ERROR)
    expect(checkCarDocumentSize('abc')).toBe(CAR_DOCUMENT_EMPTY_ERROR)
  })
  it('says the limit in MB', () => {
    expect(CAR_DOCUMENT_SIZE_ERROR).toContain('25 MB')
  })
})

it('reads enough head bytes for the HEIF sniff (it looks at up to 256)', () => {
  expect(CAR_DOCUMENT_HEAD_BYTES).toBeGreaterThanOrEqual(256)
})
