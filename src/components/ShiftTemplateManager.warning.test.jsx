// @vitest-environment jsdom
//
// D4 UINITS.1 — the warning a deactivate or reactivate returns must survive
// the list reload. setTemplateActive wrote the warning and THEN re-read the
// list, and fetchTemplates clears the banner as it starts, so the warning
// ("the template changed, but the calendar did not fully follow") was wiped
// before anyone saw it. The copy flow already re-reads first (TPLCLONE.1).

import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'

import ShiftTemplateManager from '@/components/ShiftTemplateManager'

const MANAGER = { id: 'u1', role: 'manager', activeLocation: { id: 'loc1', name: 'Stillorgan' } }
const MORNING = {
  id: 't-morning', name: 'Morning', start_time: '06:00', end_time: '14:00',
  color: '#10B981', active: true, max_coaches: 4, min_coaches: 1,
  days_of_week: ['mon'], role_label: null, display_order: 0,
}
const WARNING = 'The template changed, but 2 future shifts could not be updated.'

function mockFetch(templates, mutation) {
  return vi.fn(async (url, opts) => {
    const u = String(url)
    if (opts?.method === 'DELETE' || opts?.method === 'PUT') {
      return { ok: true, status: 200, json: async () => mutation }
    }
    if (u.includes('template-qualifications')) {
      return { ok: true, status: 200, json: async () => ({ success: true, data: { qualifications: [], requirements: {} } }) }
    }
    return { ok: true, status: 200, json: async () => ({ success: true, data: templates }) }
  })
}

beforeEach(() => { vi.spyOn(window, 'confirm').mockReturnValue(true) })
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('a deactivate / reactivate warning survives the reload (D4 UINITS.1)', () => {
  it('deactivate: the warning shows after the list re-reads', async () => {
    global.fetch = mockFetch([MORNING], { success: true, propagation: { deactivatedBlocksDeleted: 0 }, warning: WARNING })
    await act(async () => { render(<ShiftTemplateManager user={MANAGER} />) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Deactivate the Morning template' })) })
    expect(screen.getByText(WARNING)).toBeTruthy()
    expect(screen.getByText('The template changed, but the calendar did not fully follow')).toBeTruthy()
    // and the list was re-read (initial load + reload)
    const listReads = global.fetch.mock.calls.filter(([u, o]) => String(u).includes('/api/schedule/templates?') && !o?.method)
    expect(listReads.length).toBeGreaterThanOrEqual(2)
  })

  it('reactivate: the warning shows after the list re-reads', async () => {
    global.fetch = mockFetch([MORNING, { ...MORNING, id: 't-evening', name: 'Evening', active: false }], { success: true, warning: WARNING })
    await act(async () => { render(<ShiftTemplateManager user={MANAGER} />) })
    const reactivate = screen.getByRole('button', { name: 'Reactivate the Evening template' })
    await act(async () => { fireEvent.click(reactivate) })
    expect(screen.getByText(WARNING)).toBeTruthy()
  })

  it('no warning: no banner, and the deactivate notice still shows', async () => {
    global.fetch = mockFetch([MORNING], { success: true, propagation: { deactivatedBlocksDeleted: 0 } })
    await act(async () => { render(<ShiftTemplateManager user={MANAGER} />) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Deactivate the Morning template' })) })
    expect(screen.queryByText('The template changed, but the calendar did not fully follow')).toBeNull()
    expect(screen.getByText(/Deactivated/)).toBeTruthy()
  })
})
