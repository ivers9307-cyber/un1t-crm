// @vitest-environment jsdom
//
// ROSTER-FIX.6b — the calendar's five overlays are dialogs now, every
// icon-only control has a name, and the week-view block card answers the
// keyboard.
//
// 🔴 Memory `jsdom-cannot-see-layout`: jsdom has NO layout engine, so the
// responsive part of 6b (the overflow-x-auto + min-w-[840px] wrappers) is
// unprovable here — className assertions would pass on a wrapper that renders
// nothing. That half needs a browser at 390px. What IS provable is the
// semantics: roles, names, focus and key handling, and that is all this file
// claims.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent, act } from '@testing-library/react'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace() {} }),
  usePathname: () => '/schedule',
  useSearchParams: () => new URLSearchParams(),
}))

import ScheduleCalendar from '@/components/ScheduleCalendar'

// A dialog's accessible name is whatever aria-labelledby points at — the
// assertion the whole conversion is for.
function dialogName(dialog) {
  const id = dialog.getAttribute('aria-labelledby')
  return id ? document.getElementById(id).textContent : null
}

function isoToday() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// Monday of the rendered week, so the fixtures always land in a visible column.
function isoMonday() {
  const d = new Date()
  const day = d.getDay()
  d.setDate(d.getDate() - day + (day === 0 ? -6 : 1))
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const TEMPLATE = { id: 't1', name: 'Morning', start_time: '09:00', end_time: '12:00', color: '#3B82F6', active: true, max_coaches: 3 }

// Both fixtures sit on today (or Monday, whichever is later in the week) so
// `isBlockUnstaffedFuture` sees them as future demand.
const BLOCK_DATE = isoMonday() > isoToday() ? isoMonday() : isoToday()

const STAFFED_BLOCK = {
  id: 'b1',
  location_id: 'loc1',
  block_date: BLOCK_DATE,
  template_id: 't1',
  start_time: '09:00',
  end_time: '12:00',
  max_coaches: 3,
  shift_templates: TEMPLATE,
  shift_assignments: [{
    id: 'a1',
    profile_id: 'u2',
    status: 'confirmed',
    start_time_override: '09:30',
    end_time_override: null,
    partial_reason: 'covered until 12',
    profiles: { full_name: 'Sarah Doyle' },
  }],
}

const UNSTAFFED_BLOCK = {
  id: 'b2',
  location_id: 'loc1',
  block_date: BLOCK_DATE,
  template_id: 't1',
  start_time: '17:00',
  end_time: '20:00',
  max_coaches: 2,
  shift_templates: { ...TEMPLATE, id: 't1', name: 'Evening' },
  shift_assignments: [],
}

const STAFF = [
  { id: 'u1', full_name: 'Colm Manager', role: 'manager', active: true, profile_locations: [{ location_id: 'loc1' }] },
  { id: 'u2', full_name: 'Sarah Doyle', role: 'coach', active: true, profile_locations: [{ location_id: 'loc1' }] },
  { id: 'u3', full_name: 'Mike Byrne', role: 'coach', active: true, profile_locations: [{ location_id: 'loc1' }] },
]

const MANAGER = { id: 'u1', role: 'manager', activeLocation: { id: 'loc1', name: 'Stillorgan' } }
// A coach who is on the staffed block, so the swap affordance is reachable.
const COACH = { id: 'u2', role: 'coach', activeLocation: { id: 'loc1', name: 'Stillorgan' } }

function mockFetch() {
  return vi.fn((url) => {
    const body = url.includes('/api/schedule/blocks') ? { success: true, data: [STAFFED_BLOCK, UNSTAFFED_BLOCK] }
      : url.includes('/api/schedule/templates') ? { success: true, data: [TEMPLATE] }
        : url.includes('/api/staff') ? { success: true, data: STAFF }
          : url.includes('/api/schedule/time-off') ? { success: true, data: [] }
            : url.includes('/holidays') ? { success: true, data: [] }
              : url.includes('contractor-spend') ? { success: true, data: null }
                // The publish modal's dry run.
                : { success: true, impact: { blockCount: 2, periodProjectedEur: 400, monthProjectedTotalEur: 900, monthlyBudgetEur: 2000, overBudget: false } }
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) })
  })
}

// ROSTER-FIX.6b-7 — the card's click target is now a real <button> stretched
// over a plain container, not a role="button" on the container itself, so the
// handle the tests grab is the button and the card is its parent.
function cardButton(name) {
  return screen.getByRole('button', { name: new RegExp(`^Manage .*${name} shift,`) })
}

async function renderCalendar(user = MANAGER) {
  global.fetch = mockFetch()
  await act(async () => { render(<ScheduleCalendar user={user} />) })
  return cardButton('Morning')
}

beforeEach(() => { vi.stubGlobal('confirm', () => true) })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

// ─── the block card is a control, not decoration ──────────────────────
describe('week-view block card (ROSTER-FIX.6b)', () => {
  it('is a real button, reachable by keyboard, and opens the detail dialog', async () => {
    const trigger = await renderCalendar()
    expect(trigger).toBeTruthy()
    // A native <button type="button"> is what gives Enter and Space — and the
    // Space scroll suppression — for free. jsdom does not synthesise the
    // click a browser fires for those keys, so the element TYPE is the
    // guarantee being asserted, not a simulated keypress.
    expect(trigger.tagName).toBe('BUTTON')
    expect(trigger.getAttribute('type')).toBe('button')

    trigger.focus()
    expect(document.activeElement).toBe(trigger)

    fireEvent.click(trigger)
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('leaves the card itself a plain container, so its own text stays browsable', async () => {
    const trigger = await renderCalendar()
    const card = trigger.parentElement
    // The regression this replaced: role="button" + tabIndex on the CARD
    // flattened every child into one accessible name, swallowing the coach
    // list and the sr-only "Unstaffed."/"Adjusted hours…" spans 6b added.
    expect(card.getAttribute('role')).toBeNull()
    expect(card.getAttribute('tabindex')).toBeNull()
    // Its contents are separate nodes a screen reader can walk.
    expect(card.textContent).toContain('Sarah Doyle')
    expect(card.textContent).toContain('Adjusted hours')
    // The mouse-only hover hint is out of the accessibility tree.
    const hint = Array.from(card.querySelectorAll('div')).find(n => n.textContent.trim() === 'Click to manage')
    expect(hint.getAttribute('aria-hidden')).toBe('true')
  })

  it('names the card by its own shift and day, not by everything inside it', async () => {
    const trigger = await renderCalendar()
    // Seven columns of "Manage this shift" would be indistinguishable in a
    // controls list, and the whole card as a name is unreadable.
    expect(trigger.textContent).toMatch(/^Manage 9am Morning shift, \w+day,? \d+ \w+$/)
    expect(trigger.textContent).not.toContain('Sarah Doyle')
  })

  it('keeps aria-pressed on the button in select mode', async () => {
    await renderCalendar()
    // Outside select mode the card is not a toggle, so it carries no state.
    expect(cardButton('Morning').getAttribute('aria-pressed')).toBeNull()

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Select multiple/ })) })
    const selectMorning = () => screen.getByRole('button', { name: /^Select .*Morning shift,/ })
    expect(selectMorning().getAttribute('aria-pressed')).toBe('false')

    await act(async () => { fireEvent.click(selectMorning()) })
    expect(selectMorning().getAttribute('aria-pressed')).toBe('true')
  })
})

// ─── each overlay is a real dialog ────────────────────────────────────
describe('the calendar overlays are dialogs (ROSTER-FIX.6b)', () => {
  it('BlockDetailModal: labelled, focused, Escape closes, focus goes back to the card', async () => {
    const card = await renderCalendar()
    card.focus()
    fireEvent.click(card)

    const dialog = screen.getByRole('dialog')
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    // The dialog's accessible name is the template, not a generic word.
    expect(dialog.getAttribute('aria-labelledby')).toBeTruthy()
    expect(document.getElementById(dialog.getAttribute('aria-labelledby')).textContent).toBe('Morning')
    // Focus is inside the dialog, not left behind on the calendar.
    expect(dialog.contains(document.activeElement)).toBe(true)

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(card)
  })

  it('AssignCoachModal: opens from the detail dialog, is labelled, Escape closes', async () => {
    const card = await renderCalendar()
    fireEvent.click(card)
    fireEvent.click(screen.getByRole('button', { name: /Add coach/i }))

    const dialog = screen.getByRole('dialog')
    expect(dialogName(dialog)).toBe('Assign coaches')
    expect(dialog.contains(document.activeElement)).toBe(true)

    // Escape drops back to the block detail (`blockDetail && !assignTarget`),
    // which is the pre-existing flow — the assign dialog is what closes.
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(dialogName(screen.getByRole('dialog'))).toBe('Morning')
  })

  it('CreateBlockModal: opens from Add Slot and returns focus to it', async () => {
    await renderCalendar()
    const trigger = screen.getAllByRole('button', { name: /Add Slot/i })[0]
    trigger.focus()
    fireEvent.click(trigger)

    const dialog = screen.getByRole('dialog')
    expect(dialogName(dialog)).toMatch(/^Add Shift Slot/)
    expect(dialog.contains(document.activeElement)).toBe(true)

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('PublishRosterModal: opens from Publish and returns focus to it', async () => {
    await renderCalendar()
    const trigger = screen.getByRole('button', { name: /^Publish$/ })
    trigger.focus()
    await act(async () => { fireEvent.click(trigger) })

    const dialog = screen.getByRole('dialog')
    expect(dialogName(dialog)).toBe('Publish roster')
    expect(dialog.contains(document.activeElement)).toBe(true)

    await act(async () => { fireEvent.keyDown(document, { key: 'Escape' }) })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('SwapModal: a coach opens it from their own row and Escape closes it', async () => {
    const card = await renderCalendar(COACH)
    fireEvent.click(card)
    fireEvent.click(screen.getByRole('button', { name: /Request a swap for Sarah Doyle/ }))

    const dialog = screen.getByRole('dialog')
    expect(dialogName(dialog)).toBe('Request Shift Swap')
    expect(dialog.contains(document.activeElement)).toBe(true)

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

// ─── a half-filled row survives a stray click ─────────────────────────
describe('BlockDetailModal keeps an open row editor (ROSTER-FIX.6b-7)', () => {
  it('does not close on a backdrop click while a coach row is being edited', async () => {
    const card = await renderCalendar()
    fireEvent.click(card)
    const dialog = screen.getByRole('dialog')

    // Closed rows: a stray click outside costs nothing, so the default holds.
    fireEvent.mouseDown(dialog.parentElement)
    expect(screen.queryByRole('dialog')).toBeNull()

    // Re-open it and put Sarah's row into its inline times editor.
    fireEvent.click(cardButton('Morning'))
    fireEvent.click(screen.getByRole('button', { name: 'Edit adjusted times for Sarah Doyle' }))
    // The inline editor is open and holds unsaved times.
    expect(screen.getByRole('button', { name: /Save/ })).toBeTruthy()

    fireEvent.mouseDown(screen.getByRole('dialog').parentElement)
    expect(screen.getByRole('dialog')).toBeTruthy()
    // Escape and the close button are still there — this is dismissOnBackdrop,
    // not dismissable={false}, which would leave no exit at all.
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

// ─── nothing is named "button" ────────────────────────────────────────
describe('every icon-only control on the calendar has a name (ROSTER-FIX.6b)', () => {
  it('names the week arrows, and renames them in month view', async () => {
    await renderCalendar()
    expect(screen.getByRole('button', { name: 'Previous week' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Next week' })).toBeTruthy()

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Month' })) })
    expect(screen.getByRole('button', { name: 'Previous month' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Next month' })).toBeTruthy()
  })

  it('names the per-coach swap / adjust / remove icons after the coach', async () => {
    const card = await renderCalendar()
    fireEvent.click(card)
    // Sarah's row carries an override, so the control offers to EDIT it.
    expect(screen.getByRole('button', { name: 'Edit adjusted times for Sarah Doyle' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Remove Sarah Doyle from this shift' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy()
  })

  it('leaves no button on the page whose only name is its markup', async () => {
    await renderCalendar()
    for (const btn of screen.getAllByRole('button')) {
      const name = (btn.getAttribute('aria-label') || btn.textContent || '').trim()
      expect(name.length, btn.outerHTML.slice(0, 160)).toBeGreaterThan(0)
    }
  })
})

// ─── state is not carried by colour alone ─────────────────────────────
describe('unstaffed and adjusted read as text (ROSTER-FIX.6b)', () => {
  it('says "Unstaffed" in text on the week card, not only in red', async () => {
    await renderCalendar()
    const eveningCard = cardButton('Evening').parentElement
    // Specifically the visually-hidden word beside the glyph — the red wash
    // and red left rule are the things that do not survive greyscale, and the
    // italic "Unstaffed - assign a coach" line only appears while the block
    // has zero coaches AND the viewer is a manager.
    const hidden = Array.from(eveningCard.querySelectorAll('.sr-only')).map(n => n.textContent.trim())
    expect(hidden).toContain('Unstaffed.')
  })

  it('says "Unstaffed" on the month grid bar, where the only signal was a red hairline', async () => {
    await renderCalendar()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Month' })) })

    // The mini bar for the evening block: red border only, before 6b.
    const bars = Array.from(document.querySelectorAll('.sr-only')).map(n => n.textContent.trim())
    expect(bars).toContain('Unstaffed.')
    // And the day cell's count chip is spoken as well as shown as "!2".
    expect(bars.some(t => /unstaffed$/.test(t))).toBe(true)
  })

  it('gives the override marker a spoken name instead of a bare bullet', async () => {
    await renderCalendar()
    expect(screen.getByText(/Adjusted hours: 9:30am to 12pm/)).toBeTruthy()
  })
})
