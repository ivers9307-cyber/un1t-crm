// @vitest-environment jsdom
//
// LEAVEBAL.1 — Schedule › Leave balances wiring: the team read, Unknown vs
// n/a vs numbers, the allowance PUT, the lieu ledger (add hours, lieu taken
// with the 409 shown, remove a manual entry with an in-page confirm, no remove
// on an automatic credit), the year picker, and a head coach's read-only ledger.

import React from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, act, within } from '@testing-library/react'
import LeaveBalancesManager, { fmtNumber, yearOptions } from './LeaveBalancesManager'

const LOC = 'loc-1'
const TEAM = {
  location_id: LOC, year: 2026, today: '2026-11-16', can_edit_allowance: true, can_record_lieu: true, unreadable: [],
  rows: [
    { profile_id: 'ann', full_name: 'Ann Coach', employment_type: 'fte', not_applicable: false,
      holiday: { stored: true, total_days: 22, carried_over: 2, used_days: 5, remaining: 19 }, pending_days: 3,
      lieu: { credited_hours: 10.67, taken_hours: 4, balance_hours: 6.67 } },
    { profile_id: 'bob', full_name: 'Bob Coach', employment_type: 'fte', not_applicable: false,
      holiday: { stored: false, total_days: 25, carried_over: 0, used_days: 0, remaining: 25 }, pending_days: 0, lieu: null },
    { profile_id: 'cat', full_name: 'Cat Contractor', employment_type: 'contractor', not_applicable: true, holiday: null, pending_days: null, lieu: null },
  ],
}
const LEDGER = {
  profile_id: 'ann', year: 2026, credited_hours: 10.67, taken_hours: 4, balance_hours: 6.67,
  entries: [
    { id: 'auto1', source: 'sunday_worked', credit_date: '2026-06-07', hours: 10.67, note: null, holiday_name: null },
    { id: 'tk1', source: 'taken', credit_date: '2026-07-01', hours: -4, note: 'Day off', holiday_name: null },
  ],
}

function mockFetch({ team = TEAM, ledger = LEDGER, postStatus = 201, postBody = { success: true, data: {} } } = {}) {
  const calls = []
  global.fetch = vi.fn(async (url, opts = {}) => {
    const method = opts.method || 'GET'
    const u = String(url)
    calls.push({ url: u, method, body: opts.body ? JSON.parse(opts.body) : null })
    if (u.startsWith('/api/schedule/allowances/team')) {
      const y = new URL(u, 'http://x').searchParams.get('year')
      return { ok: true, status: 200, json: async () => ({ success: true, data: { ...team, year: y ? Number(y) : team.year } }) }
    }
    if (u.startsWith('/api/schedule/allowances/lieu') && method === 'GET') return { ok: true, status: 200, json: async () => ({ success: true, data: ledger }) }
    if (u.startsWith('/api/schedule/allowances/lieu') && method === 'POST') return { ok: postStatus < 300, status: postStatus, json: async () => postBody }
    return { ok: true, status: 200, json: async () => ({ success: true, data: {} }) }
  })
  return calls
}

async function renderIt(opts) {
  const calls = mockFetch(opts)
  await act(async () => { render(<LeaveBalancesManager />) })
  return calls
}

const rowOf = (name) => screen.getByText(name).closest('tr')

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('helpers', () => {
  it('fmtNumber: null is Unknown, never 0', () => {
    expect(fmtNumber(null)).toBe('Unknown')
    expect(fmtNumber(undefined, ' h')).toBe('Unknown')
    expect(fmtNumber(0, ' h')).toBe('0 h')
    expect(fmtNumber(6.666, ' h')).toBe('6.67 h')
  })
  it('yearOptions around the current year', () => {
    expect(yearOptions(2026)).toEqual([2024, 2025, 2026, 2027])
    expect(yearOptions(null)).toEqual([])
  })
})

describe('LeaveBalancesManager', () => {
  it('reads the team once and shows days, hours, Unknown and n/a', async () => {
    const calls = await renderIt()
    expect(calls[0]).toMatchObject({ url: '/api/schedule/allowances/team', method: 'GET' })
    expect(calls.filter((c) => c.url.startsWith('/api/schedule/allowances/team'))).toHaveLength(1)
    const ann = within(rowOf('Ann Coach'))
    expect(ann.getByText('22')).toBeTruthy()
    expect(ann.getByText('19')).toBeTruthy()
    expect(ann.getByText('6.67 h')).toBeTruthy()
    expect(within(rowOf('Bob Coach')).getByText('Unknown')).toBeTruthy()
    expect(within(rowOf('Cat Contractor')).getAllByText('n/a').length).toBe(6)
    expect(screen.queryByRole('button', { name: 'Edit allowance for Cat Contractor' })).toBeNull()
  })

  it('says which part could not be read', async () => {
    await renderIt({ team: { ...TEAM, unreadable: ['lieu'] } })
    expect(screen.getByRole('alert').textContent).toMatch(/Could not read lieu ledgers.*Unknown, not 0/)
  })

  it('the year picker reloads that year', async () => {
    const calls = await renderIt()
    await act(async () => { fireEvent.change(screen.getByLabelText('Year'), { target: { value: '2025' } }) })
    expect(calls.at(-1).url).toBe('/api/schedule/allowances/team?year=2025')
  })

  it('Edit allowance PUTs total and carry-over, then reloads', async () => {
    const calls = await renderIt()
    fireEvent.click(screen.getByRole('button', { name: 'Edit allowance for Ann Coach' }))
    fireEvent.change(screen.getByLabelText('Total days'), { target: { value: '24' } })
    fireEvent.change(screen.getByLabelText('Carried over (days)'), { target: { value: '3.5' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })) })
    expect(calls.find((c) => c.method === 'PUT')).toEqual({
      url: '/api/schedule/allowances', method: 'PUT',
      body: { profile_id: 'ann', year: 2026, total_days: 24, carried_over: 3.5 },
    })
    expect(screen.getByRole('status').textContent).toBe('Allowance saved for Ann Coach.')
    expect(calls.at(-1).url).toBe('/api/schedule/allowances/team?year=2026')
  })

  it('the ledger: automatic credits have no remove; a taken entry removes after an in-page confirm', async () => {
    const calls = await renderIt()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Lieu ledger for Ann Coach' })) })
    expect(calls.find((c) => c.url.startsWith('/api/schedule/allowances/lieu'))).toMatchObject({ url: '/api/schedule/allowances/lieu?profile_id=ann&year=2026', method: 'GET' })
    const list = screen.getByRole('list', { name: 'Lieu entries' })
    expect(within(list).getAllByRole('button', { name: /^Remove/ })).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Remove Lieu taken on 2026-07-01' }))
    expect(calls.find((c) => c.method === 'DELETE')).toBeUndefined()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Confirm remove' })) })
    expect(calls.find((c) => c.method === 'DELETE')).toMatchObject({ url: '/api/schedule/allowances/lieu?id=tk1' })
  })

  it('Add hours POSTs a manual credit at the studio with the note; Save waits for a note', async () => {
    const calls = await renderIt()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Lieu ledger for Ann Coach' })) })
    fireEvent.click(screen.getByRole('button', { name: 'Add hours' }))
    fireEvent.change(screen.getByLabelText(/^Hours/), { target: { value: '2.5' } })
    const save = screen.getByRole('button', { name: 'Save' })
    expect(save.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText(/^Note/), { target: { value: '  Covered open day  ' } })
    expect(save.disabled).toBe(false)
    await act(async () => { fireEvent.click(save) })
    expect(calls.find((c) => c.method === 'POST')).toEqual({
      url: '/api/schedule/allowances/lieu', method: 'POST',
      body: { profile_id: 'ann', location_id: LOC, source: 'manual', hours: 2.5, credit_date: '2026-11-16', note: 'Covered open day' },
    })
  })

  it('Record lieu taken shows the 409 message when more than is banked', async () => {
    const msg = 'Only 6.67 lieu hours are banked on 2026-11-16; 8 cannot be taken.'
    await renderIt({ postStatus: 409, postBody: { success: false, error: msg, data: { balance_hours: 6.67 } } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Lieu ledger for Ann Coach' })) })
    fireEvent.click(screen.getByRole('button', { name: 'Record lieu taken' }))
    fireEvent.change(screen.getByLabelText(/^Hours/), { target: { value: '8' } })
    fireEvent.change(screen.getByLabelText(/^Note/), { target: { value: 'Long weekend' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })) })
    expect(screen.getByText(msg)).toBeTruthy()
  })

  it('a head coach sees the ledger read-only', async () => {
    await renderIt({ team: { ...TEAM, can_record_lieu: false } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Lieu ledger for Ann Coach' })) })
    expect(screen.queryByRole('button', { name: 'Add hours' })).toBeNull()
    expect(screen.queryByRole('button', { name: /^Remove/ })).toBeNull()
    expect(screen.getByText(/Only owners and managers/)).toBeTruthy()
  })
})
