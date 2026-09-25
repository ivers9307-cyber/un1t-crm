// @vitest-environment jsdom
//
// QUALS.1 — a template's advisory requirements in the template editor: the
// chip on the list, the field in the form, and the separate PUT that saves
// them after the template (only when the set changed). When the catalogue
// does not load, there is no field and the template saves exactly as before.

import React from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'
import ShiftTemplateManager from '@/components/ShiftTemplateManager'

const MANAGER = { id: 'u1', role: 'manager', activeLocation: { id: 'loc1', name: 'Stillorgan' } }
const MORNING = {
  id: 't-class', name: 'Morning', start_time: '06:00', end_time: '07:00', color: '#10B981', active: true,
  max_coaches: 10, min_coaches: 2, days_of_week: ['mon'], role_label: null, display_order: 0, kind: 'class',
}
const TYPES = [
  { id: 'fa', name: 'First aid', active: true },
  { id: 'ins', name: 'Insurance', active: true },
  { id: 'gv', name: 'Garda vetting', active: true },
  { id: 'old', name: 'Old cert', active: false },
]

async function renderManager({ quals = { types: TYPES, requirements: { 't-class': ['fa'] } }, qualsFail = false } = {}) {
  const writes = []
  global.fetch = vi.fn(async (url, opts) => {
    const u = String(url)
    if (opts?.method === 'PUT' || opts?.method === 'POST') {
      writes.push({ url: u, method: opts.method, body: JSON.parse(opts.body) })
      return { ok: true, status: opts.method === 'POST' ? 201 : 200, json: async () => ({ success: true, data: { id: 't-new' } }) }
    }
    if (u.startsWith('/api/schedule/template-qualifications')) {
      return qualsFail
        ? { ok: false, status: 500, json: async () => ({ success: false, error: 'down' }) }
        : { ok: true, status: 200, json: async () => ({ success: true, data: quals }) }
    }
    return { ok: true, status: 200, json: async () => ({ success: true, data: [MORNING] }) }
  })
  await act(async () => { render(<ShiftTemplateManager user={MANAGER} />) })
  return writes
}

const save = async (label = 'Save Changes') => {
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: label })) })
}

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('template list', () => {
  it('shows what a template asks for', async () => {
    await renderManager()
    expect(screen.getByText('Requires First aid')).toBeTruthy()
  })
})

describe('template editor — Requires', () => {
  it('opens with the current requirements ticked, archived types hidden unless already required', async () => {
    await renderManager()
    fireEvent.click(screen.getByRole('button', { name: 'Edit the Morning template' }))
    expect(screen.getByRole('checkbox', { name: 'First aid' }).checked).toBe(true)
    expect(screen.getByRole('checkbox', { name: 'Insurance' }).checked).toBe(false)
    expect(screen.queryByRole('checkbox', { name: /Old cert/ })).toBeNull()
  })

  it('saves the template first, then PUTs the new set; the template body carries no requirements', async () => {
    const writes = await renderManager()
    fireEvent.click(screen.getByRole('button', { name: 'Edit the Morning template' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Insurance' }))
    await save()
    expect(writes.map((w) => `${w.method} ${w.url}`)).toEqual([
      'PUT /api/schedule/templates/t-class',
      'PUT /api/schedule/template-qualifications',
    ])
    expect(writes[0].body).not.toHaveProperty('required_qualification_type_ids')
    expect(writes[1].body).toEqual({ template_id: 't-class', qualification_type_ids: ['fa', 'ins'] })
  })

  it('an unchanged set is not saved again', async () => {
    const writes = await renderManager()
    fireEvent.click(screen.getByRole('button', { name: 'Edit the Morning template' }))
    await save()
    expect(writes).toHaveLength(1)
  })

  it('a NEW template gets its requirements under the id the create returned', async () => {
    const writes = await renderManager()
    fireEvent.click(screen.getByRole('button', { name: 'New Shift' }))
    fireEvent.change(screen.getByPlaceholderText(/e\.g\. Morning/), { target: { value: 'Evening' } })
    fireEvent.click(screen.getByRole('checkbox', { name: 'Garda vetting' }))
    await save('Create Shift Template')
    expect(writes.map((w) => `${w.method} ${w.url}`)).toEqual([
      'POST /api/schedule/templates',
      'PUT /api/schedule/template-qualifications',
    ])
    expect(writes[1].body).toEqual({ template_id: 't-new', qualification_type_ids: ['gv'] })
  })

  it('an archived type that is already required is shown, ticked, and can be removed', async () => {
    const writes = await renderManager({ quals: { types: TYPES, requirements: { 't-class': ['old'] } } })
    fireEvent.click(screen.getByRole('button', { name: 'Edit the Morning template' }))
    const old = screen.getByRole('checkbox', { name: 'Old cert (archived)' })
    expect(old.checked).toBe(true)
    fireEvent.click(old)
    await save()
    expect(writes[1].body).toEqual({ template_id: 't-class', qualification_type_ids: [] })
  })

  it('at most 5: the rest are disabled once 5 are ticked', async () => {
    const six = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({ id, name: `Q${id}`, active: true }))
    await renderManager({ quals: { types: six, requirements: { 't-class': ['a', 'b', 'c', 'd', 'e'] } } })
    fireEvent.click(screen.getByRole('button', { name: 'Edit the Morning template' }))
    expect(screen.getByRole('checkbox', { name: 'Qf' }).disabled).toBe(true)
    expect(screen.getByRole('checkbox', { name: 'Qa' }).disabled).toBe(false)
  })

  it('when the catalogue does not load there is no field, and only the template is saved', async () => {
    const writes = await renderManager({ qualsFail: true })
    expect(screen.queryByText(/^Requires /)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Edit the Morning template' }))
    expect(screen.queryByRole('checkbox', { name: 'First aid' })).toBeNull()
    await save()
    expect(writes).toHaveLength(1)
    expect(writes[0].body).not.toHaveProperty('required_qualification_type_ids')
  })
})
