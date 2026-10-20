// CONTRACTS-PDF.2 — renderAndStoreSignedContractPdf on mocked builders.
//
// Pins the contract between the sign route and the backfill POST: the
// render inputs are read from the row (plus the template name, brand and
// zone the caller resolved), the PDF lands at contracts/<id>/signed.pdf,
// the path is written and JUDGED, and a failure never throws — a render
// failure leaves no buffer, a storage or path-write failure keeps the
// buffer (the sign route still attaches it to the emails).
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./contract-pdf.js', () => ({ renderContractPdf: vi.fn(async () => Buffer.from('%PDF-fake')) }))
vi.mock('./location-branding.js', () => ({ getLocationBranding: vi.fn(async () => ({ companyName: 'UN1T Stillorgan' })) }))

import { renderAndStoreSignedContractPdf, signedContractPdfPath } from './contract-pdf-store.js'
import { renderContractPdf } from './contract-pdf.js'
import { getLocationBranding } from './location-branding.js'

const CONTRACT = {
  id: 'c6a9a200-c0bc-45b9-bd12-f91ed81643fb',
  location_id: 'loc-1',
  body_rendered: '# Contract\n\nBody.',
  issuer_signature: 'Richard Ivers',
  issued_at: '2026-06-01T09:00:00.000Z',
  signature_value: 'Mark Doyle',
  signed_at: '2026-06-02T10:00:00.000Z',
  signed_ip: '192.0.2.10',
  variables_data: { employer_name: 'Champ fitness LTD' },
}

function mockDb({ uploadError = null, updateError = null, updatedRows = [{ id: CONTRACT.id }] } = {}) {
  const upload = vi.fn(async () => ({ data: uploadError ? null : { path: 'x' }, error: uploadError }))
  const select = vi.fn(async () => ({ data: updateError ? null : updatedRows, error: updateError }))
  const eq = vi.fn(() => ({ select }))
  const update = vi.fn(() => ({ eq }))
  const db = {
    from: vi.fn(() => ({ update })),
    storage: { from: vi.fn(() => ({ upload })) },
  }
  return { db, upload, update, eq, select }
}

beforeEach(() => vi.clearAllMocks())

describe('renderAndStoreSignedContractPdf', () => {
  it('renders from the row with the sign route\'s inputs and stores at <id>/signed.pdf', async () => {
    const { db, upload, update, eq } = mockDb()
    const out = await renderAndStoreSignedContractPdf({ db, contract: CONTRACT, templateName: 'Coach Contract', zone: 'Europe/Dublin' })

    expect(out.error).toBeNull()
    expect(out.pdfPath).toBe(`${CONTRACT.id}/signed.pdf`)
    expect(out.pdfPath).toBe(signedContractPdfPath(CONTRACT.id))
    expect(Buffer.isBuffer(out.pdfBuffer)).toBe(true)

    expect(getLocationBranding).toHaveBeenCalledWith(db, 'loc-1')
    expect(renderContractPdf).toHaveBeenCalledWith({
      bodyRendered: CONTRACT.body_rendered,
      issuerSignature: 'Richard Ivers',
      issuedAt: CONTRACT.issued_at,
      recipientSignature: 'Mark Doyle',
      signedAt: CONTRACT.signed_at,
      signedIp: '192.0.2.10',
      templateName: 'Coach Contract',
      companyName: 'UN1T Stillorgan',
      // the legacy row names its body's employer, not the retired literal
      contractingEntity: 'Champ fitness LTD',
      zone: 'Europe/Dublin',
    })
    expect(db.storage.from).toHaveBeenCalledWith('contracts')
    expect(upload).toHaveBeenCalledWith(`${CONTRACT.id}/signed.pdf`, out.pdfBuffer, { contentType: 'application/pdf', upsert: true })
    expect(db.from).toHaveBeenCalledWith('contracts')
    expect(update).toHaveBeenCalledWith({ signed_pdf_path: `${CONTRACT.id}/signed.pdf` })
    expect(eq).toHaveBeenCalledWith('id', CONTRACT.id)
  })

  it('a frozen legal_entity_name is the countersignature when present', async () => {
    const { db } = mockDb()
    await renderAndStoreSignedContractPdf({
      db,
      contract: { ...CONTRACT, variables_data: { legal_entity_name: 'CCF Autos Ltd', employer_name: 'Other' } },
      zone: 'Europe/Dublin',
    })
    expect(renderContractPdf.mock.calls[0][0].contractingEntity).toBe('CCF Autos Ltd')
  })

  it('a render failure: no buffer, no path, nothing uploaded, no throw', async () => {
    renderContractPdf.mockRejectedValueOnce(new Error('yoga exploded'))
    const { db, upload, update } = mockDb()
    const out = await renderAndStoreSignedContractPdf({ db, contract: CONTRACT, zone: 'Europe/Dublin' })
    expect(out).toEqual({ pdfBuffer: null, pdfPath: null, error: 'render failed: yoga exploded' })
    expect(upload).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
  })

  it('a storage failure keeps the buffer (for the emails) and writes no path', async () => {
    const { db, update } = mockDb({ uploadError: { message: 'bucket offline' } })
    const out = await renderAndStoreSignedContractPdf({ db, contract: CONTRACT, zone: 'Europe/Dublin' })
    expect(Buffer.isBuffer(out.pdfBuffer)).toBe(true)
    expect(out.pdfPath).toBeNull()
    expect(out.error).toBe('store failed: bucket offline')
    expect(update).not.toHaveBeenCalled()
  })

  it('a failed path write is an error, not a success', async () => {
    const { db } = mockDb({ updateError: { message: 'permission denied' } })
    const out = await renderAndStoreSignedContractPdf({ db, contract: CONTRACT, zone: 'Europe/Dublin' })
    expect(out.pdfPath).toBeNull()
    expect(out.error).toBe('store failed: permission denied')
  })

  it('a path write that touched no row is an error (PostgREST does not fail a zero-row UPDATE)', async () => {
    const { db } = mockDb({ updatedRows: [] })
    const out = await renderAndStoreSignedContractPdf({ db, contract: CONTRACT, zone: 'Europe/Dublin' })
    expect(out.pdfPath).toBeNull()
    expect(out.error).toMatch(/not updated/)
  })
})
