// @vitest-environment jsdom
//
// SHIFTTPL.1 — the shift-template list.
//
// Four findings on one screen:
//   1. It nagged, permanently, about templates with no weekdays. That is the
//      ONLY way to express a one-off shift placed by hand, so the banner was
//      complaining about a deliberate choice and nothing could ever clear it.
//   2. It showed the MAXIMUM and hid the minimum, which is the number that
//      decides whether a shift flags understaffed everywhere else in the app.
//   3. `display_order` has existed since the table did and nothing ever wrote
//      it, so there was no way to order the list.
//   4. A template created by mistake could only be deactivated, never removed.

import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, act, waitFor } from '@testing-library/react'

import ShiftTemplateManager from '@/components/ShiftTemplateManager'

const MANAGER = { id: 'u1', role: 'manager', activeLocation: { id: 'loc1', name: 'Stillorgan' } }

const ONE_OFF = {
  id: 't-oneoff', name: 'Open day', start_time: '09:00', end_time: '12:00',
  color: '#3B82F6', active: true, max_coaches: 3, min_coaches: 2,
  days_of_week: [], role_label: null, display_order: 0,
}
const WEEKLY = {
  id: 't-weekly', name: 'Morning', start_time: '06:00', end_time: '14:00',
  color: '#10B981', active: true, max_coaches: 10, min_coaches: 2,
  days_of_week: ['mon', 'tue'], role_label: null, display_order: 1,
}

// Every call answers the template list unless a handler overrides it.
function mockFetch(templates, handler) {
  return vi.fn(async (url, opts) => {
    const custom = handler?.(String(url), opts)
    if (custom) return custom
    return { ok: true, status: 200, json: async () => ({ success: true, data: templates }) }
  })
}

async function renderManager(templates = [ONE_OFF, WEEKLY], handler) {
  global.fetch = mockFetch(templates, handler)
  await act(async () => { render(<ShiftTemplateManager user={MANAGER} />) })
  return global.fetch
}

beforeEach(() => { vi.spyOn(window, 'confirm').mockReturnValue(true) })
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('one-off templates', () => {
  it('does not warn about a template with no weekdays', async () => {
    await renderManager()
    expect(screen.queryByText(/without applicable days/)).toBeNull()
    expect(screen.queryByText('No days set')).toBeNull()
  })

  it('labels it One-off instead', async () => {
    await renderManager()
    expect(screen.getByText('One-off')).toBeTruthy()
  })
})

describe('coach range', () => {
  it('shows the minimum as well as the maximum', async () => {
    await renderManager()
    expect(screen.getByText('min 2, up to 3 coaches')).toBeTruthy()
    expect(screen.getByText('min 2, up to 10 coaches')).toBeTruthy()
  })

  it('reads "no minimum" for an explicit 0 rather than hiding it', async () => {
    await renderManager([{ ...WEEKLY, min_coaches: 0 }])
    expect(screen.getByText('no minimum, up to 10 coaches')).toBeTruthy()
  })
})

describe('reordering', () => {
  it('writes a dense display_order for the rows that moved', async () => {
    const puts = []
    const fetchMock = await renderManager([ONE_OFF, WEEKLY], (url, opts) => {
      if (opts?.method === 'PUT') {
        puts.push({ url, body: JSON.parse(opts.body) })
        return { ok: true, status: 200, json: async () => ({ success: true, data: {} }) }
      }
      return null
    })
    expect(fetchMock).toHaveBeenCalled()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Move the Morning template up' }))
    })

    // Morning goes to 0 and Open day to 1. Only the rows whose number
    // actually changes are written.
    await waitFor(() => expect(puts).toHaveLength(2))
    expect(puts[0].url).toContain('t-weekly')
    expect(puts[0].body).toEqual({ display_order: 0 })
    expect(puts[1].url).toContain('t-oneoff')
    expect(puts[1].body).toEqual({ display_order: 1 })
  })

  it('cannot move the first row up or the last row down', async () => {
    await renderManager()
    expect(screen.getByRole('button', { name: 'Move the Open day template up' }).disabled).toBe(true)
    expect(screen.getByRole('button', { name: 'Move the Morning template down' }).disabled).toBe(true)
  })
})

describe('hard delete', () => {
  it('asks the server to delete, and says so when it did', async () => {
    let deleteUrl = null
    await renderManager([WEEKLY], (url, opts) => {
      if (opts?.method === 'DELETE') {
        deleteUrl = url
        return { ok: true, status: 200, json: async () => ({ success: true, deleted: true }) }
      }
      return null
    })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Delete the Morning template permanently' }))
    })
    expect(deleteUrl).toContain('hard=true')
    await waitFor(() => expect(screen.getByTestId('template-notice').textContent).toMatch(/was deleted/))
  })

  it('explains the refusal and points at deactivate, without claiming success', async () => {
    await renderManager([WEEKLY], (url, opts) => {
      if (opts?.method === 'DELETE') {
        return {
          ok: false,
          status: 409,
          json: async () => ({
            success: false, error: 'template_in_use', blocks: 12, assignments: 3,
            message: 'This template has shifts on the calendar and 3 coach assignments, so it cannot be deleted. Deactivate it instead, which keeps them.',
          }),
        }
      }
      return null
    })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Delete the Morning template permanently' }))
    })
    await waitFor(() => expect(screen.getByText(/Deactivate it instead/)).toBeTruthy())
    // Never the raw code, never "Could not load shift templates" over it, and
    // no Retry — retrying a refusal is not the answer.
    expect(screen.queryByText('template_in_use')).toBeNull()
    expect(screen.queryByTestId('template-notice')).toBeNull()
    expect(screen.getByText('This template was kept')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
  })

  it('does nothing when the confirm is declined', async () => {
    window.confirm.mockReturnValue(false)
    let called = false
    await renderManager([WEEKLY], (url, opts) => {
      if (opts?.method === 'DELETE') { called = true }
      return null
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Delete the Morning template permanently' }))
    })
    expect(called).toBe(false)
  })
})

describe('deactivate', () => {
  it('reports the empty future slots it cleared and the published ones it kept', async () => {
    await renderManager([WEEKLY], (url, opts) => {
      if (opts?.method === 'DELETE') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            data: { id: 't-weekly' },
            propagation: { deactivatedBlocksDeleted: 12, publishedEmptiesKept: 2 },
          }),
        }
      }
      return null
    })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Deactivate the Morning template' }))
    })
    await waitFor(() => {
      const notice = screen.getByTestId('template-notice').textContent
      expect(notice).toMatch(/cleared 12 empty future slots/)
      expect(notice).toMatch(/2 empty slots on an already-published week were kept/)
    })
  })
})
