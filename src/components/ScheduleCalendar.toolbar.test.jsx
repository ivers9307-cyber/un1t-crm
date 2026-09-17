// @vitest-environment jsdom
//
// CAL-UI-LOW.1 — the schedule header's action row wraps.
//
// 🔴 THIS FILE IS NOT PROOF THAT IT WRAPS. jsdom has no layout engine
// (memory `jsdom-cannot-see-layout`): it cannot tell a wrapped row from a
// row overflowing off the right edge of the page, which is exactly the
// defect being fixed. The wrapping was verified in a real browser at
// 360 / 390 / 768px against the shipped classes; this is the regression
// pin that stops the classes being dropped again, nothing more.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, screen, act, waitFor } from '@testing-library/react'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace() {} }),
  usePathname: () => '/schedule',
  useSearchParams: () => new URLSearchParams(),
}))

import ScheduleCalendar from '@/components/ScheduleCalendar'

const MANAGER = { id: 'u1', role: 'manager', activeLocation: { id: 'loc1', name: 'Stillorgan' } }

function mockFetch() {
  return vi.fn((url) => {
    const u = String(url)
    const body = u.includes('contractor-spend') || u.includes('week-cost')
      ? { success: true, data: null }
      : { success: true, data: [] }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) })
  })
}

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('schedule toolbar (CAL-UI-LOW.1)', () => {
  it('keeps the wrapping classes, and Publish inside the wrapping row', async () => {
    global.fetch = mockFetch()
    await act(async () => { render(<ScheduleCalendar user={MANAGER} />) })
    await waitFor(() => expect(screen.queryByText(/Loading roster/)).toBeNull())

    const toolbar = screen.getByTestId('schedule-toolbar')
    expect(toolbar.className).toMatch(/\bflex-wrap\b/)
    // The row that holds the toolbar has to wrap too — the toolbar wrapping
    // internally is no use if its parent still pins it beside the title.
    expect(toolbar.parentElement.className).toMatch(/\bflex-wrap\b/)

    // Publish is a child of the wrapping row, so it lands on a later line
    // rather than off the right edge of a phone.
    const publish = screen.getByRole('button', { name: /^Publish$/ })
    expect(toolbar.contains(publish)).toBe(true)
    // Nothing in the row may break mid-label: the wrap goes between pills.
    expect(publish.className).toMatch(/whitespace-nowrap/)
  })
})
