// @vitest-environment jsdom
//
// SHIFTTYPE.1 — the template editor's Kind control, and the list's Admin label.
import React from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'

import ShiftTemplateManager from '@/components/ShiftTemplateManager'

const MANAGER = { id: 'u1', role: 'manager', activeLocation: { id: 'loc1', name: 'Stillorgan' } }
const CLASS_T = {
  id: 't-class', name: 'Morning', start_time: '06:00', end_time: '07:00', color: '#10B981', active: true,
  max_coaches: 10, min_coaches: 2, days_of_week: ['mon'], role_label: null, display_order: 0, kind: 'class',
}
const ADMIN_T = {
  id: 't-admin', name: 'Stock take', start_time: '14:00', end_time: '15:00', color: '#3B82F6', active: true,
  max_coaches: 2, min_coaches: 0, days_of_week: ['fri'], role_label: null, display_order: 1, kind: 'admin',
}

async function renderManager(templates = [CLASS_T, ADMIN_T]) {
  const writes = []
  global.fetch = vi.fn(async (url, opts) => {
    if (opts?.method === 'PUT' || opts?.method === 'POST') {
      writes.push({ url: String(url), method: opts.method, body: JSON.parse(opts.body) })
      return { ok: true, status: 200, json: async () => ({ success: true, data: {} }) }
    }
    return { ok: true, status: 200, json: async () => ({ success: true, data: templates }) }
  })
  await act(async () => { render(<ShiftTemplateManager user={MANAGER} />) })
  return writes
}

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('template list', () => {
  it('labels an admin template "Admin", and its range reads no minimum', async () => {
    await renderManager()
    expect(screen.getAllByText('Admin')).toHaveLength(1)
    expect(screen.getByText('no minimum, up to 2 coaches')).toBeTruthy()
  })
})

describe('template editor — Kind', () => {
  it('an existing class template opens on Class, its minimum editable', async () => {
    await renderManager()
    fireEvent.click(screen.getByRole('button', { name: 'Edit the Morning template' }))
    expect(screen.getByRole('radio', { name: /^Class/ }).checked).toBe(true)
    const min = screen.getByLabelText(/Minimum coaches/)
    expect(min.disabled).toBe(false)
    expect(min.value).toBe('2')
  })

  it('choosing Admin sets the minimum to 0, locks it, and saves kind and minimum together', async () => {
    const writes = await renderManager()
    fireEvent.click(screen.getByRole('button', { name: 'Edit the Morning template' }))
    fireEvent.click(screen.getByRole('radio', { name: /^Admin/ }))
    const min = screen.getByLabelText(/Minimum coaches/)
    expect(min.disabled).toBe(true)
    expect(min.value).toBe('0')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save Changes' })) })
    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatchObject({ url: '/api/schedule/templates/t-class', method: 'PUT', body: { kind: 'admin', min_coaches: 0 } })
  })

  it('switching an admin template back to Class restores a minimum of 1', async () => {
    const writes = await renderManager()
    fireEvent.click(screen.getByRole('button', { name: 'Edit the Stock take template' }))
    expect(screen.getByRole('radio', { name: /^Admin/ }).checked).toBe(true)
    fireEvent.click(screen.getByRole('radio', { name: /^Class/ }))
    expect(screen.getByLabelText(/Minimum coaches/).value).toBe('1')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save Changes' })) })
    expect(writes[0].body).toMatchObject({ kind: 'class', min_coaches: 1 })
  })

  it('a new template starts as Class', async () => {
    await renderManager()
    fireEvent.click(screen.getByRole('button', { name: /New Shift/ }))
    expect(screen.getByRole('radio', { name: /^Class/ }).checked).toBe(true)
  })
})
