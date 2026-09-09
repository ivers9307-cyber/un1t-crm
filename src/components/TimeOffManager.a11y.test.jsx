// @vitest-environment jsdom
//
// ROSTER-FIX.6b — the time-off request form is a dialog, and the
// approve/reject/cancel icons say WHICH request they act on.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent, act } from '@testing-library/react'

vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams() }))

import TimeOffManager from '@/components/TimeOffManager'

const MANAGER = { id: 'u1', role: 'manager', activeLocation: { id: 'loc1', name: 'Stillorgan' } }

const REQUESTS = [{
  id: 'r1',
  profile_id: 'u2',
  type: 'holiday',
  status: 'pending',
  start_date: '2026-10-01',
  end_date: '2026-10-03',
  total_days: 3,
  reason: 'Family holiday',
  profiles: { full_name: 'Sarah Doyle' },
}]

async function renderManager() {
  global.fetch = vi.fn((url) => Promise.resolve({
    ok: true,
    json: () => Promise.resolve(
      url.includes('allowance')
        ? { success: true, data: { total_days: 20, used_days: 4, carried_over: 2, remaining: 18 } }
        : { success: true, data: REQUESTS },
    ),
  }))
  await act(async () => { render(<TimeOffManager user={MANAGER} />) })
}

afterEach(cleanup)

describe('TimeOffManager accessibility (ROSTER-FIX.6b)', () => {
  it('opens the request form as a labelled dialog and gives focus back to the trigger', async () => {
    await renderManager()
    const trigger = screen.getByRole('button', { name: /Request Time Off/ })
    trigger.focus()
    fireEvent.click(trigger)

    const dialog = screen.getByRole('dialog')
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(document.getElementById(dialog.getAttribute('aria-labelledby')).textContent).toBe('Request Time Off')
    expect(dialog.contains(document.activeElement)).toBe(true)

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('names the approve and reject icons after the request they decide', async () => {
    await renderManager()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Team Requests' })) })

    expect(screen.getByRole('button', { name: 'Approve Holiday request from Sarah Doyle' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Reject Holiday request from Sarah Doyle' })).toBeTruthy()
  })

  it('leaves no unnamed button on the page', async () => {
    await renderManager()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Team Requests' })) })
    for (const btn of screen.getAllByRole('button')) {
      const name = (btn.getAttribute('aria-label') || btn.textContent || '').trim()
      expect(name.length, btn.outerHTML.slice(0, 160)).toBeGreaterThan(0)
    }
  })
})
