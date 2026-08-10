// @vitest-environment jsdom
//
// GAPS-P4 — the notice's job is to appear, name the real local time, offer the
// alternative, and never touch the send. These tests pin all four, plus the
// two fail-safe behaviours: no flash before the config loads, and the default
// window still applies when the config fetch fails.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, waitFor, fireEvent } from '@testing-library/react'

import SendQuietHoursNotice from './SendQuietHoursNotice.jsx'

// Sat 08 Aug 2026 22:44 Dublin — the instant 994 people got a sale email.
const LATE_NIGHT = '2026-08-08T21:44:00Z'
// Sat 08 Aug 2026 20:10 Dublin — the 20:00 hour, 6,092 legitimate sends.
const EVENING = '2026-08-08T19:10:00Z'

function mockConfig(data) {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    json: async () => ({ success: true, data }),
  })))
}

const DEFAULTS = { enabled: true, start_hour: 21, end_hour: 8, can_edit: true }

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('SendQuietHoursNotice', () => {
  beforeEach(() => mockConfig(DEFAULTS))

  it('warns for a 22:44 send, naming the local time and the window', async () => {
    const { findByRole } = render(
      <SendQuietHoursNotice locationId="loc-1" at={LATE_NIGHT} onSuggest={() => {}} />
    )
    const notice = await findByRole('status')
    expect(notice.textContent).toMatch(/22:44/)
    expect(notice.textContent).toMatch(/21:00 to 08:00/)
    // No em-dashes and no emoji in operator copy.
    expect(notice.textContent).not.toMatch(/—/)
  })

  it('offers the next acceptable slot and hands it back as an ISO instant', async () => {
    const onSuggest = vi.fn()
    const { findByRole } = render(
      <SendQuietHoursNotice locationId="loc-1" at={LATE_NIGHT} onSuggest={onSuggest} />
    )
    const button = await findByRole('button')
    expect(button.getAttribute('type')).toBe('button')
    expect(button.textContent).toMatch(/08:00/)
    fireEvent.click(button)
    // 08:00 Dublin the next morning, in IST.
    expect(onSuggest).toHaveBeenCalledWith('2026-08-09T07:00:00.000Z')
  })

  it('says nothing about a 20:10 send', async () => {
    const { container, queryByRole } = render(
      <SendQuietHoursNotice locationId="loc-1" at={EVENING} onSuggest={() => {}} />
    )
    await waitFor(() => expect(fetch).toHaveBeenCalled())
    expect(queryByRole('status')).toBeNull()
    expect(container.textContent).toBe('')
  })

  it('states the slot as text when the surface has no schedule control', async () => {
    const { findByRole, queryByRole } = render(
      <SendQuietHoursNotice locationId="loc-1" at={LATE_NIGHT} />
    )
    const notice = await findByRole('status')
    expect(notice.textContent).toMatch(/next slot outside quiet hours is 08:00/)
    expect(queryByRole('button')).toBeNull()
  })

  it('renders nothing before the config resolves, so it cannot flash', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
    const { container } = render(
      <SendQuietHoursNotice locationId="loc-1" at={LATE_NIGHT} onSuggest={() => {}} />
    )
    expect(container.textContent).toBe('')
  })

  it('still applies the default window when the config fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    const { findByRole } = render(
      <SendQuietHoursNotice locationId="loc-1" at={LATE_NIGHT} onSuggest={() => {}} />
    )
    const notice = await findByRole('status')
    expect(notice.textContent).toMatch(/21:00 to 08:00/)
  })

  it('stays silent when the location has switched quiet hours off', async () => {
    mockConfig({ ...DEFAULTS, enabled: false })
    const { container, queryByRole } = render(
      <SendQuietHoursNotice locationId="loc-1" at={LATE_NIGHT} onSuggest={() => {}} />
    )
    await waitFor(() => expect(fetch).toHaveBeenCalled())
    expect(queryByRole('status')).toBeNull()
    expect(container.textContent).toBe('')
  })

  it('honours a location-specific window', async () => {
    mockConfig({ ...DEFAULTS, start_hour: 23, end_hour: 6 })
    const { container, queryByRole } = render(
      <SendQuietHoursNotice locationId="loc-1" at={LATE_NIGHT} onSuggest={() => {}} />
    )
    // 22:44 is outside a 23:00 to 06:00 window.
    await waitFor(() => expect(fetch).toHaveBeenCalled())
    expect(queryByRole('status')).toBeNull()
    expect(container.textContent).toBe('')
  })
})
