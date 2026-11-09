// @vitest-environment jsdom
// HOSTPORTAL.4 — per-source copy buttons, the QR link and the not-on-sale line.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor, act } from '@testing-library/react'
import EventShareLinks from './EventShareLinks.jsx'
import { SHARE_SOURCES, taggedEventUrl } from '@/lib/event-share-links'

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers() })

const URL_ = 'https://studio.test/event/summer-run'

describe('EventShareLinks', () => {
  it('copies the tagged link for each source', async () => {
    const writeText = vi.fn(async () => {})
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    render(<EventShareLinks url={URL_} eventId="e1" onSale />)
    for (const { token, label } of SHARE_SOURCES) {
      fireEvent.click(screen.getByRole('button', { name: label }))
      await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(taggedEventUrl(URL_, token)))
    }
    expect(writeText).toHaveBeenCalledTimes(SHARE_SOURCES.length)
    expect(writeText).toHaveBeenCalledWith(`${URL_}?utm_source=instagram`)
  })

  it('shows Copied for two seconds, then the label again', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn(async () => {}) } })
    render(<EventShareLinks url={URL_} eventId="e1" onSale />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'WhatsApp' })) })
    expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy()
    await act(async () => { await vi.advanceTimersByTimeAsync(1900) })
    expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy()
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    expect(screen.getByRole('button', { name: 'WhatsApp' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Copied' })).toBeNull()
  })

  it('shows the tagged link in a read-only field when the clipboard refuses', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn(async () => { throw new Error('denied') }) } })
    render(<EventShareLinks url={URL_} eventId="e1" onSale />)
    expect(screen.queryByText('Copy this link:')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'WhatsApp' }))
    await waitFor(() => expect(screen.getByText('Copy this link:')).toBeTruthy())
    const field = screen.getByLabelText('Copy this link:')
    expect(field.value).toBe(`${URL_}?utm_source=whatsapp`)
    expect(field.readOnly).toBe(true)
    expect(screen.queryByRole('button', { name: 'Copied' })).toBeNull()
  })

  it('shows the not-on-sale line only when onSale is false', () => {
    const { unmount } = render(<EventShareLinks url={URL_} eventId="e1" onSale />)
    expect(screen.queryByText(/not on sale yet/)).toBeNull()
    unmount()
    render(<EventShareLinks url={URL_} eventId="e1" onSale={false} />)
    expect(screen.getByText('This event is not on sale yet, so these links will not open for the public.')).toBeTruthy()
  })

  it("links the QR button to the event's QR route, opening in a new tab rather than saving a file", () => {
    render(<EventShareLinks url={URL_} eventId="e1" onSale />)
    const a = screen.getByRole('link', { name: 'QR code' })
    expect(a.getAttribute('href')).toBe('/api/host/events/e1/qr')
    expect(a.hasAttribute('download')).toBe(false)
    expect(a.getAttribute('target')).toBe('_blank')
    expect(a.getAttribute('rel')).toBe('noopener noreferrer')
  })

  it('shows the help line', () => {
    render(<EventShareLinks url={URL_} eventId="e1" onSale />)
    expect(screen.getByText('Bookings from each link show up by source on the Insights tab.')).toBeTruthy()
  })
})
