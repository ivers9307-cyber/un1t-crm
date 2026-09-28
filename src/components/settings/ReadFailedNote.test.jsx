// @vitest-environment jsdom
//
// CHANNELREAD.1 — the one "we could not read this" rendering for the
// per-location settings screens. Same sentence and Try again as the hub's
// UnreadableNote (HUBREAD.1). The only action it ever offers is a re-read.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import ReadFailedNote from './ReadFailedNote.jsx'

afterEach(() => cleanup())

describe('ReadFailedNote', () => {
  it('says what could not be loaded and offers only Try again', () => {
    render(<ReadFailedNote what="the Instagram connection" onRetry={() => {}} />)
    expect(screen.getByText('Could not load the Instagram connection just now, so nothing is shown and nothing can be changed here until it loads.')).toBeTruthy()
    const buttons = screen.getAllByRole('button')
    expect(buttons).toHaveLength(1)
    expect(buttons[0].textContent).toBe('Try again')
    expect(buttons[0].getAttribute('type')).toBe('button')
  })

  it('runs onRetry, and says so when the retry failed again (still mounted)', async () => {
    const onRetry = vi.fn(async () => {})
    render(<ReadFailedNote what="the ad accounts" onRetry={onRetry} />)
    expect(screen.queryByText(/Still could not load/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(onRetry).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.getByText('Still could not load. Try again in a minute.')).toBeTruthy())
  })

  it('with href (server-rendered data) renders a link back to the page, not a button', () => {
    render(<ReadFailedNote what="the Xero connection" href="/settings/locations/x?tab=xero" />)
    expect(screen.queryByRole('button')).toBeNull()
    const link = screen.getByRole('link', { name: 'Try again' })
    expect(link.getAttribute('href')).toBe('/settings/locations/x?tab=xero')
  })
})
