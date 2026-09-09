// @vitest-environment jsdom
//
// ROSTER-FIX.6b — the recurring-report modal is a dialog. Its close control
// used to be a Plus icon rotated 45 degrees with NO accessible name at all,
// which is the single worst control on the schedule: a screen reader could
// not tell it from the "add" button it is literally made of.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent, act } from '@testing-library/react'

import ScheduleReporting from '@/components/ScheduleReporting'

const MANAGER = { id: 'u1', role: 'manager', activeLocation: { id: 'loc1', name: 'Stillorgan' } }

async function renderReporting() {
  global.fetch = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: [] }) }))
  await act(async () => { render(<ScheduleReporting user={MANAGER} />) })
}

afterEach(cleanup)

describe('ScheduleReporting accessibility (ROSTER-FIX.6b)', () => {
  it('opens the schedule modal as a labelled dialog and returns focus to the trigger', async () => {
    await renderReporting()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Staff Hours Worked/ })) })

    const trigger = screen.getByRole('button', { name: 'Schedule' })
    trigger.focus()
    await act(async () => { fireEvent.click(trigger) })

    const dialog = screen.getByRole('dialog')
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(document.getElementById(dialog.getAttribute('aria-labelledby')).textContent).toBe('Schedule Recurring Report')
    expect(dialog.contains(document.activeElement)).toBe(true)

    // The close control has a name now, and it is not the rotated Plus.
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy()

    await act(async () => { fireEvent.keyDown(document, { key: 'Escape' }) })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('leaves no unnamed button on the page, dialog included', async () => {
    await renderReporting()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Staff Hours Worked/ })) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Schedule' })) })
    for (const btn of screen.getAllByRole('button')) {
      const name = (btn.getAttribute('aria-label') || btn.textContent || '').trim()
      expect(name.length, btn.outerHTML.slice(0, 160)).toBeGreaterThan(0)
    }
  })
})
