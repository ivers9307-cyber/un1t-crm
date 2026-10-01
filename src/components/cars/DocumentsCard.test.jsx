// @vitest-environment jsdom
//
// CARDOCUPLOAD.1 (C124) — the car Documents picker. main posted multipart and
// called a bare res.json(), so a scan over ~4.5 MB met Vercel's plain-text 413,
// threw, left the row on "Uploading…" forever and showed nothing. Pinned:
// the picker uploads through uploadCarDocument (the signed flow, whose
// decisions are src/lib/car-document-upload-client.test.js), the spinner
// ALWAYS clears, a failure shows its words, a success appends the row.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'

vi.mock('@/lib/car-document-upload-client', () => ({ uploadCarDocument: vi.fn() }))

import DocumentsCard from './DocumentsCard'
import { uploadCarDocument } from '@/lib/car-document-upload-client'

const car = { id: 'c0000000-0000-0000-0000-000000000001', car_documents: [] }

function mount() {
  const setCar = vi.fn()
  const setError = vi.fn()
  const utils = render(<DocumentsCard car={car} setCar={setCar} setError={setError} disabled={false} />)
  const inputs = utils.container.querySelectorAll('input[type="file"]')
  return { ...utils, setCar, setError, inputs }
}
function pick(input, file) {
  fireEvent.change(input, { target: { files: [file] } })
}
const scan = () => new File(['%PDF-1.7'], 'big-scan.pdf', { type: 'application/pdf' })
const uploading = () => screen.queryAllByText('Uploading…')

beforeEach(() => vi.clearAllMocks())
afterEach(() => cleanup())

describe('DocumentsCard upload', () => {
  it('uploads through the signed flow for the row it was picked on, and appends the row', async () => {
    uploadCarDocument.mockResolvedValue({ success: true, data: { id: 'd1', doc_type: 'nct_invoice', filename: 'big-scan.pdf' } })
    const { inputs, setCar, setError } = mount()
    const file = scan()
    pick(inputs[0], file)
    await waitFor(() => expect(setCar).toHaveBeenCalled())
    expect(uploadCarDocument).toHaveBeenCalledWith({ carId: car.id, docType: 'nct_invoice', file })
    expect(setCar.mock.calls[0][0]({ car_documents: [{ id: 'd0' }] })).toEqual({ car_documents: [{ id: 'd0' }, { id: 'd1', doc_type: 'nct_invoice', filename: 'big-scan.pdf' }] })
    expect(setError).toHaveBeenCalledWith(null)
    expect(setError).not.toHaveBeenCalledWith(expect.any(String))
    expect(uploading()).toHaveLength(0)
  })

  it('shows the failure in words and clears the spinner (main: stuck on Uploading…, no error)', async () => {
    let settle
    uploadCarDocument.mockReturnValue(new Promise((r) => { settle = r }))
    const { inputs, setCar, setError } = mount()
    pick(inputs[0], scan())
    await waitFor(() => expect(uploading()).toHaveLength(1))
    settle({ success: false, error: 'Unsupported file type (PDF, JPEG, PNG, GIF, WebP or HEIC)' })
    await waitFor(() => expect(setError).toHaveBeenCalledWith('Unsupported file type (PDF, JPEG, PNG, GIF, WebP or HEIC)'))
    expect(uploading()).toHaveLength(0)
    expect(setCar).not.toHaveBeenCalled()
  })

  it('clears the spinner and shows an error even if the upload throws', async () => {
    uploadCarDocument.mockRejectedValue(new Error('boom'))
    const { inputs, setError } = mount()
    pick(inputs[0], scan())
    await waitFor(() => expect(setError).toHaveBeenCalledWith('Upload failed: boom'))
    expect(uploading()).toHaveLength(0)
  })

  it('never posts the file to a Vercel route itself', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    uploadCarDocument.mockResolvedValue({ success: true, data: { id: 'd1' } })
    const { inputs, setCar } = mount()
    pick(inputs[0], scan())
    await waitFor(() => expect(setCar).toHaveBeenCalled())
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })
})
