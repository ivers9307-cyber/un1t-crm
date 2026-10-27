// @vitest-environment jsdom
//
// CARDLENS.6 — the Timeline's Note button files the note at the page's acting
// studio (the locationId the page hands it), via POST …/notes location_id.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react'
import ContactActions from './ContactActions.jsx'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }))
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const HATCH = 'f0000000-0000-4000-8000-00000000000f'

describe('ContactActions — Note at the acting studio', () => {
  it('sends location_id with the note', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ success: true }) }))
    vi.stubGlobal('fetch', fetchMock)
    render(<ContactActions contactId="c-1" locationId={HATCH} canNote />)
    fireEvent.click(screen.getByRole('button', { name: /Note/ }))
    fireEvent.change(screen.getByPlaceholderText('Add a note...'), { target: { value: 'Hi' } })
    const form = screen.getByPlaceholderText('Add a note...').closest('form')
    // jsdom does not expose named controls as form properties; the browser does.
    Object.defineProperty(form, 'content', { value: form.elements.namedItem('content') })
    fireEvent.submit(form)
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/contacts/c-1/notes')
    expect(JSON.parse(init.body)).toEqual({ content: 'Hi', location_id: HATCH })
  })
})
