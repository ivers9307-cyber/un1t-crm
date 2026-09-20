// @vitest-environment jsdom
//
// CAL-UI-LOW.2 — the Studio Overview day dialog.
//
// Two defects, both found by reading the markup rather than using it:
//
//  1. It was a bespoke fixed overlay with a hand-rolled Escape listener.
//     Nothing moved focus into it, Tab walked straight out into the
//     calendar behind it, and closing it dropped a keyboard operator on
//     document.body. It is on the Modal primitive now, whose contract is
//     pinned in Modal.a11y.test.jsx — this file proves the dialog USES it.
//
//  2. It named the shifts that are below their coach minimum and then left
//     the operator to find them by eye in the calendar underneath. Each row
//     is a control now, and reports (date, block id) upward.
//
// 🔴 Focus and activation are the whole subject here and jsdom answers both
// honestly. LAYOUT is NOT verified by this file (memory
// `jsdom-cannot-see-layout`): nothing here says the dialog fits a phone.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent, act, waitFor, within } from '@testing-library/react'

import StudioOverviewStrip from '@/components/schedule/StudioOverviewDialog'

const RANGE = { from: '2026-09-21', to: '2026-09-27' }
const LOCATION = 'a0000000-0000-0000-0000-000000000001'

const DAY = {
  date: '2026-09-22',
  events: [],
  event_types: [],
  time_off: [],
  staff_scheduled: 1,
  staff_on_leave: 0,
  demand: 3,
  classification: 'amber',
  under_min_blocks: [
    { id: 'blk-early', label: 'Early', time: '06:30–09:00', assigned: 1, min: 2 },
    { id: 'blk-late', label: 'Evening', time: '17:00–20:00', assigned: 0, min: 1 },
  ],
}

const GREEN_DAY = {
  date: '2026-09-21',
  events: [], event_types: [], time_off: [],
  staff_scheduled: 2, staff_on_leave: 0, demand: 0,
  classification: 'green', under_min_blocks: [],
}

function mockOverview(days) {
  global.fetch = vi.fn(() => Promise.resolve({
    ok: true,
    json: () => Promise.resolve({ success: true, data: { from: RANGE.from, to: RANGE.to, days } }),
  }))
}

async function renderStrip({ days = [GREEN_DAY, DAY], onOpenShift } = {}) {
  mockOverview(days)
  await act(async () => {
    render(<StudioOverviewStrip range={RANGE} locationId={LOCATION} onOpenShift={onOpenShift} />)
  })
  await waitFor(() => expect(screen.queryByText(/Loading overview/)).toBeNull())
}

// The day card for DAY — the control that opens the dialog, and the one
// focus has to come back to.
function dayCard() {
  return screen.getByRole('button', { name: /undermanned/i })
}

afterEach(() => { cleanup(); vi.unstubAllGlobals() })
beforeEach(() => { vi.restoreAllMocks() })

describe('day dialog focus handling (CAL-UI-LOW.2)', () => {
  it('moves focus into the dialog when a day card opens it', async () => {
    await renderStrip()
    const card = dayCard()
    card.focus()
    fireEvent.click(card)

    const dialog = screen.getByRole('dialog')
    expect(dialog).toBeTruthy()
    expect(document.activeElement).toBe(dialog)
  })

  it('traps Tab inside the dialog', async () => {
    await renderStrip()
    fireEvent.click(dayCard())
    const dialog = screen.getByRole('dialog')

    // From the panel itself, Tab lands on the first control inside it.
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(dialog.contains(document.activeElement)).toBe(true)
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }))

    // …and from the last one it wraps back round rather than leaking into
    // the calendar behind the dialog.
    const controls = within(dialog).getAllByRole('button')
    controls[controls.length - 1].focus()
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }))
  })

  it('Escape closes it and focus returns to the day card', async () => {
    await renderStrip()
    const card = dayCard()
    card.focus()
    fireEvent.click(card)
    expect(screen.getByRole('dialog')).toBeTruthy()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(card)
    expect(document.activeElement).not.toBe(document.body)
  })

  it('the close button closes it and focus returns to the day card', async () => {
    await renderStrip()
    const card = dayCard()
    card.focus()
    fireEvent.click(card)

    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(card)
  })
})

describe('undermanned rows open the shift they name (CAL-UI-LOW.2)', () => {
  it('reports the date and block id upward, and closes the summary', async () => {
    const onOpenShift = vi.fn()
    await renderStrip({ onOpenShift })
    fireEvent.click(dayCard())

    const rows = screen.getAllByTestId('under-min-shift')
    expect(rows).toHaveLength(2)
    // The row still says everything it said before it became a control.
    expect(rows[0].textContent).toMatch(/Early/)
    expect(rows[0].textContent).toMatch(/06:30–09:00/)
    expect(rows[0].textContent).toMatch(/1 of 2 assigned/)

    fireEvent.click(rows[1])
    expect(onOpenShift).toHaveBeenCalledTimes(1)
    expect(onOpenShift).toHaveBeenCalledWith('2026-09-22', 'blk-late')
    // The summary gets out of the way — the operator asked for the shift.
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('renders the rows as plain text when there is nowhere to send the request', async () => {
    // A control that looks clickable and does nothing is worse than one that
    // never offered, so the button only exists when a handler does.
    await renderStrip({ onOpenShift: undefined })
    fireEvent.click(dayCard())

    expect(screen.queryAllByTestId('under-min-shift')).toHaveLength(0)
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText('Early')).toBeTruthy()
  })
})
