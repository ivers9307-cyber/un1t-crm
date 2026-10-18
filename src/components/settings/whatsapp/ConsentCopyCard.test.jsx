// @vitest-environment jsdom
//
// WAORGNUMBER.3 (R6) — the studio's STOP / START replies: blank shows the
// default as the placeholder, a save PUTs both fields, a failed read shows no
// boxes to save over.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import ConsentCopyCard from './ConsentCopyCard.jsx'
import { DEFAULT_CONSENT_COPY } from '@/lib/whatsapp-consent-copy'

const LOC = 'a0000000-0000-4000-8000-000000000002'
const reply = (status, body) => ({ ok: status < 400, status, json: async () => body })
const data = (copy = { stop_ack: null, start_ack: null }, canEdit = true) => ({
  copy, defaults: DEFAULT_CONSENT_COPY, studio_name: 'UN1T Hatch Street', can_edit: canEdit,
})

let putBodies
function mockServer({ getAnswer = reply(200, { success: true, data: data() }), putAnswer } = {}) {
  putBodies = []
  global.fetch = vi.fn(async (_url, init) => {
    if (init?.method === 'PUT') {
      putBodies.push(JSON.parse(init.body))
      return putAnswer(putBodies.at(-1))
    }
    return getAnswer
  })
}

afterEach(() => { cleanup(); delete global.fetch })

describe('ConsentCopyCard', () => {
  it('shows the defaults as placeholders and a preview naming the studio', async () => {
    mockServer()
    render(<ConsentCopyCard locationId={LOC} />)
    const stop = await screen.findByLabelText('Reply to STOP')
    expect(stop.value).toBe('')
    expect(stop.getAttribute('placeholder')).toBe(DEFAULT_CONSENT_COPY.stop_ack)
    expect(screen.getByText(/Customer sees: You won't get WhatsApp marketing from UN1T Hatch Street any more/)).toBeTruthy()
  })

  it('saves both fields (blank = null) and shows Saved', async () => {
    mockServer({ putAnswer: (b) => reply(200, { success: true, data: data(b) }) })
    render(<ConsentCopyCard locationId={LOC} />)
    fireEvent.change(await screen.findByLabelText('Reply to STOP'), { target: { value: 'Done. {studio} will stop.' } })
    fireEvent.click(screen.getByText('Save replies'))
    expect(await screen.findByText('Saved')).toBeTruthy()
    expect(putBodies).toEqual([{ stop_ack: 'Done. {studio} will stop.', start_ack: null }])
    expect(screen.getByText('Customer sees: Done. UN1T Hatch Street will stop.')).toBeTruthy()
  })

  it('a failed save shows the error', async () => {
    mockServer({ putAnswer: () => reply(403, { success: false, error: 'Only an owner or manager can change the STOP and START replies at this studio.' }) })
    render(<ConsentCopyCard locationId={LOC} />)
    fireEvent.click(await screen.findByText('Save replies'))
    await waitFor(() => expect(screen.getByText(/Only an owner or manager/)).toBeTruthy())
  })

  it('a failed read shows no boxes to save over', async () => {
    mockServer({ getAnswer: reply(500, { success: false, error: 'boom' }) })
    render(<ConsentCopyCard locationId={LOC} />)
    expect(await screen.findByText(/Could not load these replies/)).toBeTruthy()
    expect(screen.queryByLabelText('Reply to STOP')).toBeNull()
    expect(screen.queryByText('Save replies')).toBeNull()
  })

  it('read-only for someone who cannot edit', async () => {
    mockServer({ getAnswer: reply(200, { success: true, data: data(undefined, false) }) })
    render(<ConsentCopyCard locationId={LOC} />)
    expect((await screen.findByLabelText('Reply to STOP')).disabled).toBe(true)
    expect(screen.queryByText('Save replies')).toBeNull()
    expect(screen.getByText('An owner or manager can change these.')).toBeTruthy()
  })
})
