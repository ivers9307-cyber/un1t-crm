// @vitest-environment jsdom
//
// ROSTERLOOK.1 — the Studio Overview is a DIALOG now, opened from a day header
// in the calendar; the strip of seven tiles above the calendar is gone.
// CAL-UI-LOW.2's two guarantees carry over and are re-proved here against an
// opener the test owns: (1) it is on the Modal primitive (focus in, Tab
// trapped, Escape/close return focus to the opener), (2) an undermanned row is
// a control that reports (date, block id) upward.
//
// 🔴 Focus and activation are things jsdom answers honestly. LAYOUT is not
// (memory `jsdom-cannot-see-layout`): nothing here says the dialog fits a phone.

import { useRef, useState } from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent, act, within } from '@testing-library/react'

import StudioOverviewDialog from '@/components/schedule/StudioOverviewDialog'

const RANGE = { from: '2026-09-21', to: '2026-09-27' }
const LOCATION = 'a0000000-0000-0000-0000-000000000001'

const DAY = {
  date: '2026-09-22',
  events: [{ id: 'e1', name: 'Hyrox Simulation', kind: 'race', start_time: '10:00:00', staff_required: 3 }],
  event_types: [{ id: 'et1', name: 'Consultation', window_start: '12:00:00', window_end: '14:00:00', staff_required: 1 }],
  time_off: ['Coach C'],
  staff_scheduled: 1,
  staff_on_leave: 1,
  demand: 4,
  classification: 'amber',
  under_min_blocks: [
    { id: 'blk-early', label: 'Early', time: '06:30–09:00', assigned: 1, min: 2 },
    { id: 'blk-late', label: 'Evening', time: '17:00–20:00', assigned: 0, min: 1 },
  ],
}

function mockOverview(response) {
  global.fetch = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve(response) }))
}
const okResponse = { success: true, data: { from: RANGE.from, to: RANGE.to, days: [DAY] } }

// The opener stands in for the calendar's day header: focus has to come BACK
// to it, so the test has to own it.
function Harness({ date = DAY.date, ...props }) {
  const [openDate, setOpenDate] = useState(null)
  const openerRef = useRef(null)
  return (
    <>
      <button ref={openerRef} type="button" onClick={() => setOpenDate(date)}>open day</button>
      <StudioOverviewDialog range={RANGE} locationId={LOCATION} openDate={openDate} onClose={() => setOpenDate(null)} restoreFocusRef={openerRef} {...props} />
    </>
  )
}

async function renderHarness(props = {}, response = okResponse) {
  mockOverview(response)
  await act(async () => { render(<Harness {...props} />) })
  return screen.getByRole('button', { name: 'open day' })
}
function openFrom(opener) {
  opener.focus()
  fireEvent.click(opener)
  return screen.getByRole('dialog')
}

afterEach(() => { cleanup(); vi.unstubAllGlobals() })
beforeEach(() => { vi.restoreAllMocks() })

describe('the strip is gone (ROSTERLOOK.1)', () => {
  it('renders nothing at all while closed, but has already fetched the range', async () => {
    await renderHarness()
    expect(screen.queryByText(/Studio overview/i)).toBeNull()
    expect(screen.queryByText(/flagged/)).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getAllByRole('button')).toHaveLength(1) // only the test's opener
    expect(global.fetch).toHaveBeenCalledTimes(1)
    expect(String(global.fetch.mock.calls[0][0])).toContain(`from=${RANGE.from}&to=${RANGE.to}&location_id=${LOCATION}`)
  })
})

describe('day dialog focus handling (CAL-UI-LOW.2, carried over)', () => {
  it('moves focus into the dialog when it opens', async () => {
    const dialog = openFrom(await renderHarness())
    expect(document.activeElement).toBe(dialog)
  })

  it('traps Tab inside the dialog', async () => {
    const dialog = openFrom(await renderHarness({ onOpenShift: () => {} }))
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }))
    const controls = within(dialog).getAllByRole('button')
    controls[controls.length - 1].focus()
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }))
  })

  it('Escape closes it and focus returns to the opener', async () => {
    const opener = await renderHarness()
    openFrom(opener)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(opener)
    expect(document.activeElement).not.toBe(document.body)
  })

  // Safari does not focus a button on click, so at open time activeElement is
  // still <body> and "return focus to whatever was focused" has nothing to
  // return to. The caller hands the dialog a ref to its opener instead.
  it('returns focus to the opener it was GIVEN when the click never focused it', async () => {
    const opener = await renderHarness()
    fireEvent.click(opener) // no opener.focus(): activeElement is <body>
    expect(document.activeElement).not.toBe(opener)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(opener)
  })

  it('the close button closes it and focus returns to the opener', async () => {
    const opener = await renderHarness()
    openFrom(opener)
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(opener)
  })
})

describe('the demand data the strip showed lives in the dialog', () => {
  it('names the day, the supply-vs-demand headline, events, bookable types and who is on leave', async () => {
    const dialog = openFrom(await renderHarness())
    expect(dialog.textContent).toMatch(/Tuesday,? 22 September 2026/)
    expect(dialog.textContent).toMatch(/Undermanned/)
    expect(dialog.textContent).toMatch(/Supply 0 \/ Demand 4/)
    expect(within(dialog).getByText('Hyrox Simulation')).toBeTruthy()
    expect(dialog.textContent).toMatch(/needs 3/)
    expect(within(dialog).getByText('Consultation')).toBeTruthy()
    expect(dialog.textContent).toMatch(/12:00–14:00/)
    expect(within(dialog).getByText('Coach C')).toBeTruthy()
  })
})

describe('undermanned rows open the shift they name (CAL-UI-LOW.2, carried over)', () => {
  it('reports the date and block id upward, and closes the summary', async () => {
    const onOpenShift = vi.fn()
    openFrom(await renderHarness({ onOpenShift }))
    const rows = screen.getAllByTestId('under-min-shift')
    expect(rows).toHaveLength(2)
    // The row still says everything it said before it became a control.
    expect(rows[0].textContent).toMatch(/Early/)
    expect(rows[0].textContent).toMatch(/06:30–09:00/)
    expect(rows[0].textContent).toMatch(/1 of 2 assigned/)
    fireEvent.click(rows[1])
    expect(onOpenShift).toHaveBeenCalledTimes(1)
    expect(onOpenShift).toHaveBeenCalledWith('2026-09-22', 'blk-late')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('renders the rows as plain text when there is nowhere to send the request', async () => {
    const dialog = openFrom(await renderHarness({ onOpenShift: undefined }))
    expect(screen.queryAllByTestId('under-min-shift')).toHaveLength(0)
    expect(within(dialog).getByText('Early')).toBeTruthy()
  })
})

describe('states the strip used to show above the calendar now show in the dialog', () => {
  it('a failed overview says so inside the dialog, not nowhere', async () => {
    const opener = await renderHarness({}, { success: false, error: 'Forbidden' })
    const dialog = openFrom(opener)
    expect(dialog.textContent).toMatch(/Overview: Forbidden/)
  })

  it('a day the overview did not return says so', async () => {
    const dialog = openFrom(await renderHarness({ date: '2026-09-25' }))
    expect(dialog.textContent).toMatch(/No overview for this day/)
  })

  it('opened before the overview has answered: a loading line, then nothing to wait for', async () => {
    // A fetch that never resolves: the state under test IS "still loading".
    global.fetch = vi.fn(() => new Promise(() => {}))
    await act(async () => { render(<Harness />) })
    const dialog = openFrom(screen.getByRole('button', { name: 'open day' }))
    expect(dialog.textContent).toMatch(/Loading overview/)
  })
})
