// @vitest-environment jsdom
// HOSTPORTAL.4 — per-source copy buttons, the QR link and the not-on-sale line.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react'
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
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn(async () => {}) } })
    render(<EventShareLinks url={URL_} eventId="e1" onSale />)
    fireEvent.click(screen.getByRole('button', { name: 'WhatsApp' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy())
    await waitFor(() => expect(screen.getByRole('button', { name: 'WhatsApp' })).toBeTruthy(), { timeout: 3000 })
  })

  it('shows the not-on-sale line only when onSale is false', () => {
    const { unmount } = render(<EventShareLinks url={URL_} eventId="e1" onSale />)
    expect(screen.queryByText(/not on sale yet/)).toBeNull()
    unmount()
    render(<EventShareLinks url={URL_} eventId="e1" onSale={false} />)
    expect(screen.getByText('This event is not on sale yet, so these links will not open for the public.')).toBeTruthy()
  })

  it("links the QR button to the event's QR route, as a download", () => {
    render(<EventShareLinks url={URL_} eventId="e1" onSale />)
    const a = screen.getByRole('link', { name: 'QR code' })
    expect(a.getAttribute('href')).toBe('/api/host/events/e1/qr')
    expect(a.hasAttribute('download')).toBe(true)
  })

  it('shows the help line', () => {
    render(<EventShareLinks url={URL_} eventId="e1" onSale />)
    expect(screen.getByText('Bookings from each link show up by source on the Insights tab.')).toBeTruthy()
  })
})
