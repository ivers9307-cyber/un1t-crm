// @vitest-environment jsdom
//
// QUALS.1 — the qualifications page: the manager view (rows, chips, the
// attention filter, add / edit / delete), the read-only self view, and the
// owners' catalogue. The rules themselves are pinned in shared/qualifications.test.js.

import React from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, act, within } from '@testing-library/react'
import QualificationsManager from './QualificationsManager'

const LOC = 'loc-1'
const TYPES = [
  { id: 'fa', name: 'First aid', active: true },
  { id: 'ins', name: 'Insurance', active: true },
  { id: 'old', name: 'Old cert', active: false },
]
const MANAGER_DATA = {
  audience: 'manager', today: '2026-09-28', organization_id: 'org', can_edit_types: false, types: TYPES,
  people: [
    { profile_id: 'ann', full_name: 'Ann Coach', records: [{ id: 'r1', qualification_type_id: 'fa', issued_on: null, expires_on: '2026-09-20', note: 'PHECC' }] },
    { profile_id: 'bob', full_name: 'Bob Coach', records: [{ id: 'r2', qualification_type_id: 'fa', issued_on: null, expires_on: '2027-09-20', note: null }] },
  ],
}

function mockFetch(data, { failLoad = false } = {}) {
  const calls = []
  global.fetch = vi.fn(async (url, opts = {}) => {
    const method = opts.method || 'GET'
    calls.push({ url: String(url), method, body: opts.body ? JSON.parse(opts.body) : null })
    if (method === 'GET' && failLoad) return { ok: false, status: 500, json: async () => ({ success: false, error: 'Could not read the team' }) }
    if (method === 'GET') return { ok: true, status: 200, json: async () => ({ success: true, data }) }
    return { ok: true, status: 200, json: async () => ({ success: true, data: {} }) }
  })
  return calls
}

async function renderIt(data, opts) {
  const calls = mockFetch(data, opts)
  await act(async () => { render(<QualificationsManager locationId={LOC} />) })
  return calls
}

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('manager view', () => {
  it('lists each person with a row per ACTIVE type, a chip and the words; archived types without a record are hidden', async () => {
    const calls = await renderIt(MANAGER_DATA)
    expect(calls[0]).toMatchObject({ url: '/api/qualifications?location_id=loc-1', method: 'GET' })
    const ann = screen.getByRole('region', { name: 'Ann Coach' })
    expect(within(ann).getByText('First aid')).toBeTruthy()
    expect(within(ann).getByText('Expired', { selector: 'span' })).toBeTruthy()
    expect(within(ann).getByText('Expired 20 Sep 2026 · PHECC')).toBeTruthy()
    expect(within(ann).getByText('Insurance')).toBeTruthy()
    expect(within(ann).getByText('Not on record', { selector: 'span' })).toBeTruthy()
    expect(within(ann).queryByText(/Old cert/)).toBeNull()
  })

  it('"Only people with something expired or expiring" hides everyone else', async () => {
    await renderIt(MANAGER_DATA)
    fireEvent.click(screen.getByRole('checkbox', { name: /Only people with something expired/ }))
    expect(screen.queryByRole('region', { name: 'Bob Coach' })).toBeNull()
    expect(screen.getByRole('region', { name: 'Ann Coach' })).toBeTruthy()
  })

  it('Add opens the form for that person and type and POSTs the record (note trimmed)', async () => {
    const calls = await renderIt(MANAGER_DATA)
    fireEvent.click(screen.getByRole('button', { name: 'Add Insurance for Ann Coach' }))
    fireEvent.change(screen.getByLabelText('Expires on'), { target: { value: '2027-06-30' } })
    fireEvent.change(screen.getByLabelText('Note (optional)'), { target: { value: '  Policy 123  ' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })) })
    expect(calls.find((c) => c.method === 'POST')).toEqual({
      url: '/api/qualifications', method: 'POST',
      body: { issued_on: null, expires_on: '2027-06-30', note: 'Policy 123', profile_id: 'ann', qualification_type_id: 'ins' },
    })
    expect(screen.getByRole('status').textContent).toBe('Insurance saved for Ann Coach.')
  })

  it('Save stays off until there is an expiry date or "Does not expire" is ticked', async () => {
    await renderIt(MANAGER_DATA)
    fireEvent.click(screen.getByRole('button', { name: 'Add Insurance for Bob Coach' }))
    expect(screen.getByRole('button', { name: 'Save' }).disabled).toBe(true)
    fireEvent.click(screen.getByRole('checkbox', { name: 'Does not expire' }))
    expect(screen.getByLabelText('Expires on').disabled).toBe(true)
    expect(screen.getByRole('button', { name: 'Save' }).disabled).toBe(false)
  })

  it('Edit PATCHes the record; Delete asks first and does nothing when refused', async () => {
    const calls = await renderIt(MANAGER_DATA)
    fireEvent.click(screen.getByRole('button', { name: 'Edit First aid for Ann Coach' }))
    fireEvent.change(screen.getByLabelText('Expires on'), { target: { value: '2028-09-20' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })) })
    expect(calls.find((c) => c.method === 'PATCH')).toEqual({
      url: '/api/qualifications/r1', method: 'PATCH', body: { issued_on: null, expires_on: '2028-09-20', note: 'PHECC' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Edit First aid for Bob Coach' }))
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Delete' })) })
    expect(confirm).toHaveBeenCalled()
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false)
  })
})

describe('self view', () => {
  it('shows my rows read-only: no add, no edit, no catalogue', async () => {
    await renderIt({ ...MANAGER_DATA, audience: 'self', people: [MANAGER_DATA.people[0]] })
    expect(screen.getByText(/Your manager records these/)).toBeTruthy()
    expect(screen.getByText('Expired 20 Sep 2026 · PHECC')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^(Add|Edit) / })).toBeNull()
    expect(screen.queryByRole('region', { name: 'Qualification types' })).toBeNull()
    expect(screen.queryByRole('checkbox', { name: /Only people/ })).toBeNull()
  })
})

describe('catalogue (owners)', () => {
  it('adds a type and archives one', async () => {
    const calls = await renderIt({ ...MANAGER_DATA, can_edit_types: true })
    const cat = screen.getByRole('region', { name: 'Qualification types' })
    fireEvent.change(within(cat).getByLabelText('New qualification type'), { target: { value: ' Manual handling ' } })
    await act(async () => { fireEvent.click(within(cat).getByRole('button', { name: 'Add' })) })
    expect(calls.find((c) => c.method === 'POST')).toEqual({
      url: '/api/qualifications/types', method: 'POST', body: { location_id: LOC, name: 'Manual handling' },
    })
    await act(async () => { fireEvent.click(within(cat).getAllByRole('button', { name: 'Archive' })[0]) })
    expect(calls.find((c) => c.method === 'PATCH')).toEqual({
      url: '/api/qualifications/types/fa', method: 'PATCH', body: { active: false },
    })
  })
})

describe('failure', () => {
  it('a failed load says so; it never renders an empty team', async () => {
    await renderIt(MANAGER_DATA, { failLoad: true })
    expect(screen.getByText('Could not load qualifications')).toBeTruthy()
    expect(screen.getByText('Could not read the team')).toBeTruthy()
    expect(screen.queryByText(/Nobody here yet/)).toBeNull()
  })
})
