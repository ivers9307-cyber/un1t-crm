// @vitest-environment jsdom
//
// WAATTACH.1 — the inbox's photo/PDF panel: pick, caption, the three calls in
// order (sign → direct upload → send with the slot, never a URL), the refusals
// it shows in place, and a photo over 5 MB shrunk before signing.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'

vi.mock('@/lib/supabase', () => ({ createBrowserClient: vi.fn(() => { throw new Error('use storageClient') }) }))
vi.mock('@/lib/landing-media-upload', () => ({ compressImageForUpload: vi.fn() }))

import WAAttachmentComposer from './WAAttachmentComposer.jsx'
import { compressImageForUpload } from '@/lib/landing-media-upload'

const CONV = 'conv-1'
const MB = 1024 * 1024
const PATH = 'loc-1/outbound/conv-1/slot.pdf'

function fileOf(name, type, size) {
  const f = new File(['x'], name, { type })
  Object.defineProperty(f, 'size', { value: size })
  return f
}

let calls
let uploads
let storageClient
function respond(handlers) {
  calls = []
  global.fetch = vi.fn(async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : null
    calls.push({ url, body })
    const h = handlers[url]
    const json = typeof h === 'function' ? h(body) : h
    return { ok: json?.success !== false, status: json?.success === false ? 400 : 200, json: async () => json }
  })
}

beforeEach(() => {
  uploads = []
  storageClient = {
    storage: {
      from: (bucket) => ({
        uploadToSignedUrl: vi.fn(async (path, token, file, opts) => { uploads.push({ bucket, path, token, file, opts }); return { error: null } }),
      }),
    },
  }
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

const SIGN = `/api/whatsapp/conversations/${CONV}/attachments/sign`
const SEND = `/api/whatsapp/conversations/${CONV}/send`

function renderPanel(props = {}) {
  const onSent = vi.fn()
  const onClose = vi.fn()
  render(<WAAttachmentComposer conversationId={CONV} windowExpiry="17:30, 16 Nov" onSent={onSent} onClose={onClose} storageClient={storageClient} {...props} />)
  return { onSent, onClose }
}

describe('WAAttachmentComposer', () => {
  it('shows the limits and when the window closes, and Send waits for a file', () => {
    renderPanel()
    expect(screen.getByText(/up to 5 MB, PDFs up to 16 MB/)).toBeTruthy()
    expect(screen.getByText(/Window open until 17:30, 16 Nov/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Send' }).disabled).toBe(true)
    // Every button is a plain button (never a form submit).
    for (const b of screen.getAllByRole('button')) expect(b.getAttribute('type')).toBe('button')
  })

  it('signs, uploads straight to Storage, then sends the slot with the caption and file name', async () => {
    respond({
      [SIGN]: { success: true, data: { path: PATH, token: 'tok', content_type: 'application/pdf', kind: 'document' } },
      [SEND]: { success: true, messageId: 'wamid.1' },
    })
    const { onSent } = renderPanel()
    fireEvent.change(screen.getByTestId('wa-attachment-input'), { target: { files: [fileOf('Timetable.pdf', 'application/pdf', 2 * MB)] } })
    expect(screen.getByText('Timetable.pdf')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Caption'), { target: { value: ' November classes ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() => expect(onSent).toHaveBeenCalledWith([]))
    expect(calls.map((c) => c.url)).toEqual([SIGN, SEND])
    expect(calls[0].body).toEqual({ file_name: 'Timetable.pdf', mime: 'application/pdf', size: 2 * MB })
    expect(uploads).toHaveLength(1)
    expect(uploads[0]).toMatchObject({ bucket: 'whatsapp-media', path: PATH, token: 'tok', opts: { contentType: 'application/pdf' } })
    expect(calls[1].body).toEqual({ type: 'document', attachment_path: PATH, file_name: 'Timetable.pdf', caption: 'November classes' })
    expect(calls[1].body.media_url).toBeUndefined()
  })

  it('refuses a type WhatsApp does not take, in place, without calling the server', () => {
    respond({})
    renderPanel()
    fireEvent.change(screen.getByTestId('wa-attachment-input'), { target: { files: [fileOf('clip.mov', 'video/quicktime', MB)] } })
    expect(screen.getByRole('alert').textContent).toMatch(/photo \(JPEG or PNG\) or a PDF/)
    expect(screen.getByRole('button', { name: 'Send' }).disabled).toBe(true)
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('refuses a PDF over 16 MB when it is picked', () => {
    respond({})
    renderPanel()
    fireEvent.change(screen.getByTestId('wa-attachment-input'), { target: { files: [fileOf('big.pdf', 'application/pdf', 17 * MB)] } })
    expect(screen.getByRole('alert').textContent).toMatch(/16 MB/)
  })

  it('shrinks a photo over 5 MB before signing it', async () => {
    const small = fileOf('photo.jpg', 'image/jpeg', 3 * MB)
    compressImageForUpload.mockResolvedValue(small)
    respond({
      [SIGN]: { success: true, data: { path: 'loc-1/outbound/conv-1/slot.jpg', token: 't', content_type: 'image/jpeg', kind: 'image' } },
      [SEND]: { success: true },
    })
    const { onSent } = renderPanel()
    fireEvent.change(screen.getByTestId('wa-attachment-input'), { target: { files: [fileOf('photo.jpg', 'image/jpeg', 9 * MB)] } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(onSent).toHaveBeenCalled())
    expect(compressImageForUpload).toHaveBeenCalled()
    expect(calls[0].body.size).toBe(3 * MB)
    expect(uploads[0].file).toBe(small)
    expect(calls[1].body).toEqual({ type: 'image', attachment_path: 'loc-1/outbound/conv-1/slot.jpg', file_name: 'photo.jpg' })
  })

  it("shows the server's refusal and does not report a send", async () => {
    respond({ [SIGN]: { success: false, error: 'The 24-hour messaging window has closed, so files cannot be sent. Send an approved template instead.' } })
    const { onSent } = renderPanel()
    fireEvent.change(screen.getByTestId('wa-attachment-input'), { target: { files: [fileOf('a.png', 'image/png', MB)] } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/window has closed/))
    expect(onSent).not.toHaveBeenCalled()
    expect(uploads).toHaveLength(0)
  })

  it('shows a warning when the file went but the thread could not be updated', async () => {
    respond({
      [SIGN]: { success: true, data: { path: PATH, token: 'tok', content_type: 'application/pdf', kind: 'document' } },
      [SEND]: { success: true, warnings: ['Sent to the customer, but it could not be saved to this thread. Do not send it again.'] },
    })
    const { onSent } = renderPanel()
    fireEvent.change(screen.getByTestId('wa-attachment-input'), { target: { files: [fileOf('a.pdf', 'application/pdf', MB)] } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/Do not send it again/))
    expect(onSent).toHaveBeenCalledWith(['Sent to the customer, but it could not be saved to this thread. Do not send it again.'])
  })
})
