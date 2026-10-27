// @vitest-environment jsdom
//
// CARDLENS.6 — the contact page's composer sends for the ACTING studio: every
// note, WhatsApp and company-sender email carries `location_id` so the route
// files and judges it there (CARDLENS.5). Without sendLocationId (the pipeline
// drawer) the bodies are exactly as before.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react'
import ContactComposer from './ContactComposer.jsx'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }))

const HATCH = 'f0000000-0000-4000-8000-00000000000f'
let calls
function stubFetch() {
  calls = []
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    const u = String(url)
    calls.push({ url: u, body: init?.body ? JSON.parse(init.body) : null })
    if (u.startsWith('/api/email/mail?')) {
      return { ok: true, status: 200, json: async () => ({ success: true, data: { mailboxes: [], conversations: [] } }) }
    }
    return { ok: true, status: 200, json: async () => ({ success: true }) }
  }))
}
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const base = { contactId: 'c-1', contactName: 'John', canWhatsApp: true, canEmail: true, hasWaPhone: true, hasEmail: true, contactEmail: 'john@example.com', whatsappWindowOpen: true }
const sent = (path) => calls.find((c) => c.url === path)?.body

describe('ContactComposer — sends for the acting studio', () => {
  it('a WhatsApp text carries location_id', async () => {
    stubFetch()
    render(<ContactComposer {...base} contactLocationId={HATCH} sendLocationId={HATCH} defaultChannel="whatsapp" />)
    fireEvent.change(screen.getByPlaceholderText(/Message John on WhatsApp/), { target: { value: 'Hi' } })
    fireEvent.click(screen.getByRole('button', { name: /^Send$/ }))
    await waitFor(() => expect(sent('/api/contacts/c-1/whatsapp')).toEqual({ text: 'Hi', location_id: HATCH }))
  })

  it('a note carries location_id', async () => {
    stubFetch()
    render(<ContactComposer {...base} contactLocationId={HATCH} sendLocationId={HATCH} />)
    fireEvent.change(screen.getByPlaceholderText(/Add a note about John/), { target: { value: 'Asked about Fridays' } })
    fireEvent.click(screen.getByRole('button', { name: /Save note/ }))
    await waitFor(() => expect(sent('/api/contacts/c-1/notes')).toEqual({ content: 'Asked about Fridays', location_id: HATCH }))
  })

  it('a company-sender email carries location_id', async () => {
    stubFetch()
    render(<ContactComposer {...base} contactLocationId={HATCH} sendLocationId={HATCH} defaultChannel="email" />)
    await screen.findByText('Sent from the company address')
    fireEvent.change(screen.getByPlaceholderText('Subject'), { target: { value: 'Hello' } })
    fireEvent.change(screen.getByPlaceholderText(/Email John/), { target: { value: 'Hi.' } })
    fireEvent.click(screen.getByRole('button', { name: /Send email/ }))
    await waitFor(() => expect(sent('/api/contacts/c-1/email')).toEqual({ subject: 'Hello', body: 'Hi.', location_id: HATCH }))
  })

  it('without sendLocationId (the drawer) the body is unchanged', async () => {
    stubFetch()
    render(<ContactComposer {...base} contactLocationId={HATCH} defaultChannel="whatsapp" />)
    fireEvent.change(screen.getByPlaceholderText(/Message John on WhatsApp/), { target: { value: 'Hi' } })
    fireEvent.click(screen.getByRole('button', { name: /^Send$/ }))
    await waitFor(() => expect(sent('/api/contacts/c-1/whatsapp')).toEqual({ text: 'Hi' }))
  })
})
