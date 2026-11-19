// @vitest-environment jsdom
// NEWEMAIL.1 — blank first, then the studio's templates; picking one creates
// the draft and opens it in the full editor.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'

const push = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }))
import NewEmailPicker from './NewEmailPicker.jsx'

const TEMPLATES = [{ id: 't1', name: 'Monthly news', subject: 'News', description: null }]
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ success: true, data: { id: 'camp-9' } }) })))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('NewEmailPicker', () => {
  it('lists Blank first, then the templates', () => {
    render(<NewEmailPicker locationId="loc-1" templates={TEMPLATES} />)
    const buttons = screen.getAllByRole('button').map((b) => b.textContent.trim())
    expect(buttons[0]).toMatch(/^Blank/)
    expect(buttons[1]).toMatch(/Monthly news/)
  })

  it('a template creates the draft with its id and opens the editor', async () => {
    render(<NewEmailPicker locationId="loc-1" templates={TEMPLATES} />)
    fireEvent.click(screen.getByRole('button', { name: /Monthly news/ }))
    await waitFor(() => expect(push).toHaveBeenCalledWith('/communications/sent/email/camp-9?edit=1'))
    const [url, opts] = fetch.mock.calls[0]
    expect(url).toBe('/api/communications/campaigns')
    expect(JSON.parse(opts.body)).toEqual({ location_id: 'loc-1', name: 'Monthly news', template_id: 't1' })
  })

  it('Blank creates a draft with no template', async () => {
    render(<NewEmailPicker locationId="loc-1" templates={TEMPLATES} />)
    fireEvent.click(screen.getByRole('button', { name: /^Blank/ }))
    await waitFor(() => expect(push).toHaveBeenCalled())
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ location_id: 'loc-1', name: 'Untitled email' })
  })

  it('a failed create says so and opens nothing', async () => {
    fetch.mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({ success: false, error: 'Template not found' }) })
    render(<NewEmailPicker locationId="loc-1" templates={TEMPLATES} />)
    fireEvent.click(screen.getByRole('button', { name: /Monthly news/ }))
    expect((await screen.findByRole('alert')).textContent).toBe('Template not found')
    expect(push).not.toHaveBeenCalled()
  })

  it('says when the templates could not be read, and when there are none', () => {
    const { rerender } = render(<NewEmailPicker locationId="loc-1" templates={[]} readFailed />)
    expect(screen.getByText(/could not be read just now/)).toBeTruthy()
    rerender(<NewEmailPicker locationId="loc-1" templates={[]} />)
    expect(screen.getByText(/No marketing templates yet/)).toBeTruthy()
  })
})
