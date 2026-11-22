// @vitest-environment jsdom
//
// USUALCOACH.1 — a template's usual coaches in the template editor: the chip
// on the list, the field in the form (this studio's active staff only), and
// usual_coach_ids in the template save only when the list changed.

import React from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'
import ShiftTemplateManager, { usualCoachOptions } from '@/components/ShiftTemplateManager'

const MANAGER = { id: 'u1', role: 'manager', activeLocation: { id: 'loc1', name: 'Stillorgan' } }
const MORNING = {
  id: 't-class', name: 'Morning', start_time: '06:00', end_time: '07:00', color: '#10B981', active: true,
  max_coaches: 10, min_coaches: 2, days_of_week: ['mon'], role_label: null, display_order: 0, kind: 'class',
  usual_coach_ids: ['p-bea', 'p-gone'],
}
const at = (loc) => [{ location_id: loc, role: 'staff' }]
const STAFF = [
  { id: 'p-ann', full_name: 'Ann', active: true, profile_locations: at('loc1') },
  { id: 'p-bea', full_name: 'Bea', active: true, profile_locations: at('loc1') },
  { id: 'p-off', full_name: 'Off Duty', active: false, profile_locations: at('loc1') },
  { id: 'p-hatch', full_name: 'Hatch Only', active: true, profile_locations: at('loc2') },
]

async function renderManager({ staff = STAFF, staffFail = false } = {}) {
  const writes = []
  const reads = []
  global.fetch = vi.fn(async (url, opts) => {
    const u = String(url)
    if (opts?.method === 'PUT' || opts?.method === 'POST') {
      writes.push({ url: u, method: opts.method, body: JSON.parse(opts.body) })
      return { ok: true, status: opts.method === 'POST' ? 201 : 200, json: async () => ({ success: true, data: { id: 't-new' } }) }
    }
    reads.push(u)
    if (u.startsWith('/api/staff')) {
      return staffFail
        ? { ok: false, status: 500, json: async () => ({ success: false, error: 'down' }) }
        : { ok: true, status: 200, json: async () => ({ success: true, data: staff }) }
    }
    if (u.startsWith('/api/schedule/template-qualifications')) {
      return { ok: false, status: 500, json: async () => ({ success: false, error: 'off' }) }
    }
    return { ok: true, status: 200, json: async () => ({ success: true, data: [MORNING] }) }
  })
  await act(async () => { render(<ShiftTemplateManager user={MANAGER} />) })
  return { writes, reads }
}

const save = async (label = 'Save Changes') => {
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: label })) })
}

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('usualCoachOptions', () => {
  it('keeps active staff of this studio, A to Z', () => {
    expect(usualCoachOptions(STAFF, 'loc1')).toEqual([{ id: 'p-ann', full_name: 'Ann' }, { id: 'p-bea', full_name: 'Bea' }])
    expect(usualCoachOptions(null, 'loc1')).toEqual([])
  })
})

describe('template editor — usual coaches', () => {
  it('reads the pay-free staff list for this studio only, and names the usual coaches on the list', async () => {
    const { reads } = await renderManager()
    expect(reads).toContain('/api/staff?fields=picker&location_id=loc1')
    expect(screen.getByText('Usually Bea')).toBeTruthy()
  })

  it('offers only active staff of this studio, with the saved coach ticked', async () => {
    await renderManager()
    fireEvent.click(screen.getByRole('button', { name: 'Edit the Morning template' }))
    expect(screen.getByRole('checkbox', { name: 'Bea' }).checked).toBe(true)
    expect(screen.getByRole('checkbox', { name: 'Ann' }).checked).toBe(false)
    expect(screen.queryByRole('checkbox', { name: 'Off Duty' })).toBeNull()
    expect(screen.queryByRole('checkbox', { name: 'Hatch Only' })).toBeNull()
  })

  it('saves the list in ticked order on the template itself', async () => {
    const { writes } = await renderManager()
    fireEvent.click(screen.getByRole('button', { name: 'Edit the Morning template' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Ann' }))
    await save()
    expect(writes).toHaveLength(1)
    expect(writes[0].url).toBe('/api/schedule/templates/t-class')
    expect(writes[0].body.usual_coach_ids).toEqual(['p-bea', 'p-ann'])
  })

  it('drops a saved coach who is no longer here on the next save', async () => {
    // MORNING was saved with p-gone, who is not in the staff list; nothing else changed.
    const { writes } = await renderManager()
    fireEvent.click(screen.getByRole('button', { name: 'Edit the Morning template' }))
    await save()
    expect(writes[0].body.usual_coach_ids).toEqual(['p-bea'])
  })

  it('an unchanged list is not sent', async () => {
    const { writes } = await renderManager({ staff: [...STAFF, { id: 'p-gone', full_name: 'Gone', active: true, profile_locations: at('loc1') }] })
    fireEvent.click(screen.getByRole('button', { name: 'Edit the Morning template' }))
    await save()
    expect(writes[0].body).not.toHaveProperty('usual_coach_ids')
  })

  it('when staff do not load (or the list is empty) there is no field and the save carries no list', async () => {
    for (const opts of [{ staffFail: true }, { staff: [] }]) {
      const { writes } = await renderManager(opts)
      fireEvent.click(screen.getByRole('button', { name: 'Edit the Morning template' }))
      expect(screen.queryByText('Usual coaches')).toBeNull()
      await save()
      expect(writes[0].body).not.toHaveProperty('usual_coach_ids')
      cleanup()
    }
  })
})
