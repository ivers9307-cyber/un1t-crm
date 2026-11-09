// @vitest-environment jsdom
// HOSTPORTAL.4 — the Email your list block's client button.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react'

const push = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }))

const { default: AnnounceEventButton } = await import('./AnnounceEventButton.jsx')

afterEach(() => { cleanup(); vi.unstubAllGlobals() })
beforeEach(() => { push.mockClear() })

const NAME = 'Write an email about this event'

describe('AnnounceEventButton', () => {
  it('posts once on a double click and goes to the composer with open and notice', async () => {
    let resolve
    const fetchMock = vi.fn(() => new Promise((r) => { resolve = r }))
    vi.stubGlobal('fetch', fetchMock)
    render(<AnnounceEventButton eventId="e1" blockedReason={null} contactCount={42} />)
    const btn = screen.getByRole('button', { name: NAME })
    fireEvent.click(btn)
    fireEvent.click(btn)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe('/api/host/events/e1/announce-draft')
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'POST' })
    expect(btn.disabled).toBe(true)
    resolve({ ok: true, json: async () => ({ success: true, data: { id: 'c9' } }) })
    await waitFor(() => expect(push).toHaveBeenCalledWith('/host/emails?open=c9&notice=event'))
    expect(push).toHaveBeenCalledTimes(1)
  })

  it('shows the count line', () => {
    render(<AnnounceEventButton eventId="e1" blockedReason={null} contactCount={42} />)
    expect(screen.getByText(/42 contacts/)).toBeTruthy()
  })

  it('says 1 contact in the singular and omits the line when the count is unknown', () => {
    const { unmount } = render(<AnnounceEventButton eventId="e1" blockedReason={null} contactCount={1} />)
    expect(screen.getByText(/1 contact\b(?!s)/)).toBeTruthy()
    unmount()
    render(<AnnounceEventButton eventId="e1" blockedReason={null} contactCount={null} />)
    expect(screen.queryByText(/contacts?\b.*(list|on your)/i)).toBeNull()
    expect(screen.getByRole('button', { name: NAME })).toBeTruthy()
  })

  it('shows the server error, stays, and lets the host try again', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, json: async () => ({ success: false, error: 'insert exploded' }) }))
    vi.stubGlobal('fetch', fetchMock)
    render(<AnnounceEventButton eventId="e1" blockedReason={null} contactCount={3} />)
    fireEvent.click(screen.getByRole('button', { name: NAME }))
    await waitFor(() => expect(screen.getByText('insert exploded')).toBeTruthy())
    expect(push).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: NAME }).disabled).toBe(false)
  })

  it('shows a plain error when the request itself fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    render(<AnnounceEventButton eventId="e1" blockedReason={null} contactCount={3} />)
    fireEvent.click(screen.getByRole('button', { name: NAME }))
    await waitFor(() => expect(screen.getByText('Could not create the draft. Try again.')).toBeTruthy())
    expect(push).not.toHaveBeenCalled()
  })

  it('shows the given reason and no button when the shortcut is blocked', () => {
    for (const reason of [
      'Publish this event before emailing your list about it.',
      'This event is waiting for approval. You can email your list once it is on sale.',
      'This event is off sale. Put it back on sale before emailing your list about it.',
      'This event has already taken place.',
    ]) {
      const { unmount } = render(<AnnounceEventButton eventId="e1" blockedReason={reason} contactCount={3} />)
      expect(screen.getByText(reason)).toBeTruthy()
      expect(screen.queryByRole('button')).toBeNull()
      unmount()
    }
  })
})
