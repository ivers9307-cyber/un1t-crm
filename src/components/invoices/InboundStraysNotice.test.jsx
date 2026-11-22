// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import InboundStraysNotice from './InboundStraysNotice'

const ROWS = [
  { id: 's1', to_address: 'one@example.com', from_address: 'from1@example.com', subject: 'First subject', reason: 'unknown_slug', slug: 'nope', received_at: '2026-11-20T10:00:00Z' },
  { id: 's2', to_address: 'two@example.com', from_address: 'from2@example.com', subject: 'Second subject', reason: 'unparseable_recipient', slug: null, received_at: '2026-11-19T10:00:00Z' },
]
const answer = (body, ok = true) => vi.stubGlobal('fetch', vi.fn(async () => ({ ok, json: async () => body })))

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('InboundStraysNotice', () => {
  it('shows a count that opens to each row', async () => {
    answer({ success: true, data: ROWS })
    render(<InboundStraysNotice />)
    const toggle = await screen.findByRole('button', { name: /2 emails could not be matched to a studio/ })
    expect(toggle.getAttribute('type')).toBe('button')
    expect(screen.queryByText('one@example.com')).toBeNull()
    fireEvent.click(toggle)
    for (const t of ['one@example.com', 'from1@example.com', 'First subject', 'two@example.com', 'from2@example.com', 'Second subject', 'No studio uses this address', 'Address not recognised']) {
      expect(screen.getByText(t)).toBeTruthy()
    }
    expect(screen.getAllByText(/2026|Nov/).length).toBeGreaterThan(0)
  })

  it('uses the singular for one email', async () => {
    answer({ success: true, data: [ROWS[0]] })
    render(<InboundStraysNotice />)
    expect(await screen.findByRole('button', { name: /^1 email could not be matched to a studio$/ })).toBeTruthy()
  })

  it('renders nothing for an empty list', async () => {
    answer({ success: true, data: [] })
    const { container } = render(<InboundStraysNotice />)
    await waitFor(() => expect(fetch).toHaveBeenCalled())
    await new Promise((r) => setTimeout(r, 0))
    expect(container.innerHTML).toBe('')
  })

  it('renders nothing on an error', async () => {
    answer({ success: false, error: 'Could not load unmatched emails.' }, false)
    const { container } = render(<InboundStraysNotice />)
    await waitFor(() => expect(fetch).toHaveBeenCalled())
    await new Promise((r) => setTimeout(r, 0))
    expect(container.innerHTML).toBe('')
  })
})
