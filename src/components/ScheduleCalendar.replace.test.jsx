// @vitest-environment jsdom
//
// REPLACE.1a — "Replace" on a coach row in the block dialog opens the assign
// picker in single-select mode and posts one replace. The words are pinned in
// src/lib/shift-replace.test.js (replacePickerCopy, replaceResponseOutcome);
// this file pins the half a pure test cannot reach: the button is there for a
// manager on a shift today or later, the picker is the assign picker (radio,
// titled for the coach going off, no capacity line, badges kept), the POST
// carries the one pick, and a clash asks before resending with
// confirm_conflicts.

import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent, act } from '@testing-library/react'

// A week far enough ahead that it is "today or later" whatever day the suite runs.
let searchParams = 'view=week&week=2099-05-04&month=2099-05-01'
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
  usePathname: () => '/schedule',
  useSearchParams: () => new URLSearchParams(searchParams),
}))
vi.mock('./RosterSummaryPanel', () => ({ default: () => null }))

import ScheduleCalendar from './ScheduleCalendar.jsx'

// The whole calendar mounts in jsdom; under a full-suite run the waits below
// can take seconds, so they get room and the test budget covers them
// (tests/test-timeout-budgets.test.js, the ScheduleCalendar.errors precedent).
vi.setConfig({ testTimeout: 20000 })
const WAIT = { timeout: 5000 }

const LOC = 'loc1'
const manager = { id: 'u1', role: 'manager', activeLocation: { id: LOC, name: 'Studio North' } }

const blockOn = (date) => ({
  id: 'b-1',
  location_id: LOC,
  template_id: 't1',
  block_date: date,
  start_time: '10:00:00',
  end_time: '12:00:00',
  max_coaches: 3,
  shift_templates: { id: 't1', name: 'Midday Strength', start_time: '10:00:00', end_time: '12:00:00' },
  shift_assignments: [{ id: 'as-a', profile_id: 'c-a', status: 'scheduled', profiles: { full_name: 'Coach A' } }],
})

const staff = [
  { id: 'c-a', full_name: 'Coach A', role: 'staff', active: true, profile_locations: [{ location_id: LOC }] },
  { id: 'c-b', full_name: 'Coach B', role: 'staff', active: true, profile_locations: [{ location_id: LOC }] },
  { id: 'c-leave', full_name: 'Coach C', role: 'staff', active: true, profile_locations: [{ location_id: LOC }] },
]

const okResponse = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body })

let block
let replaceAnswers
const replaceCalls = () => global.fetch.mock.calls.filter(([url]) => String(url).includes('/replace'))

beforeEach(() => {
  searchParams = 'view=week&week=2099-05-04&month=2099-05-01'
  block = blockOn('2099-05-06')
  replaceAnswers = [okResponse({ success: true, data: { notice: 'now' } })]
  global.fetch = vi.fn(async (url) => {
    if (String(url).includes('/replace')) return replaceAnswers.shift()
    if (url.includes('/schedule/blocks')) return okResponse({ success: true, data: [block] })
    if (url.includes('/schedule/time-off')) {
      return okResponse({ success: true, data: [{ id: 'to1', profile_id: 'c-leave', status: 'approved', type: 'holiday', start_date: block.block_date, end_date: block.block_date, profiles: { full_name: 'Coach C' } }] })
    }
    if (url.includes('/api/staff')) return okResponse({ success: true, data: staff })
    return okResponse({ success: true, data: [] })
  })
  window.confirm = vi.fn(() => true)
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

async function openBlock() {
  render(<ScheduleCalendar user={manager} />)
  fireEvent.click(await screen.findByRole('button', { name: /^Manage 10am Midday Strength shift/ }, WAIT))
  await waitFor(() => expect(screen.getByText('Add coach')).toBeTruthy(), WAIT)
}

async function openReplacePicker() {
  await openBlock()
  fireEvent.click(screen.getByRole('button', { name: 'Replace Coach A with another coach' }))
  await waitFor(() => expect(screen.getByText('Pick the coach who takes this shift')).toBeTruthy(), WAIT)
}

describe('REPLACE.1a — the Replace button', () => {
  it('sits on a coach row of a shift today or later, for a manager', async () => {
    await openBlock()
    expect(screen.getByRole('button', { name: 'Replace Coach A with another coach' }).getAttribute('title')).toBe('Replace coach')
  })

  it('is not offered on a past day', async () => {
    searchParams = 'view=week&week=2020-05-04&month=2020-05-01'
    block = blockOn('2020-05-06')
    await openBlock()
    expect(screen.queryByRole('button', { name: 'Replace Coach A with another coach' })).toBeNull()
  })
})

describe('REPLACE.1a — the picker in replace mode', () => {
  it('is titled for the coach going off, one pick (radio), no capacity line, and keeps the badges', async () => {
    await openReplacePicker()
    expect(screen.getByRole('dialog', { name: 'Replace Coach A' })).toBeTruthy()
    const dialog = screen.getByRole('dialog', { name: 'Replace Coach A' })
    expect(dialog.textContent).not.toMatch(/assigned ·|slots? open/)
    expect(dialog.querySelectorAll('input[type="checkbox"]').length).toBe(0)
    expect(dialog.querySelectorAll('input[type="radio"]').length).toBe(2) // Coach A is on it already
    expect(screen.getByText('on approved leave')).toBeTruthy()
    const submit = screen.getByRole('button', { name: 'Pick a coach' })
    expect(submit.disabled).toBe(true)
  })

  it('a second pick replaces the first, and the button names it', async () => {
    await openReplacePicker()
    const radioFor = (name) => screen.getByText(name).closest('label').querySelector('input')
    fireEvent.click(radioFor('Coach C'))
    fireEvent.click(radioFor('Coach B'))
    expect(radioFor('Coach B').checked).toBe(true)
    expect(radioFor('Coach C').checked).toBe(false)
    expect(screen.getByRole('button', { name: 'Replace with Coach B' }).disabled).toBe(false)
  })

  it('posts the one pick to /replace and says who was told', async () => {
    await openReplacePicker()
    fireEvent.click(screen.getByText('Coach B').closest('label').querySelector('input'))
    fireEvent.click(screen.getByRole('button', { name: 'Replace with Coach B' }))
    await waitFor(() => expect(screen.getByText('Coach B is on the shift. Coach A and Coach B have been told.')).toBeTruthy(), WAIT)
    const [[url, init]] = replaceCalls()
    expect(url).toBe('/api/schedule/assignments/as-a/replace')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({ profile_id: 'c-b' })
    expect(screen.queryByText('Pick the coach who takes this shift')).toBeNull()
  })

  it('a clash asks first, in the server\'s sentence, and resends with confirm_conflicts', async () => {
    replaceAnswers = [
      okResponse({ success: false, code: 'swap_conflicts', error: 'x', conflicts: [{ kind: 'leave', message: 'Coach B has approved holiday on 2099-05-06.' }] }, 409),
      okResponse({ success: true, data: { notice: 'morning' } }),
    ]
    await openReplacePicker()
    fireEvent.click(screen.getByText('Coach B').closest('label').querySelector('input'))
    fireEvent.click(screen.getByRole('button', { name: 'Replace with Coach B' }))
    await waitFor(() => expect(replaceCalls()).toHaveLength(2), WAIT)
    expect(window.confirm).toHaveBeenCalledWith('Coach B has approved holiday on 2099-05-06.\n\nReplace anyway?')
    expect(JSON.parse(replaceCalls()[1][1].body)).toEqual({ profile_id: 'c-b', confirm_conflicts: true })
    await waitFor(() => expect(screen.getByText(/are told after 7am/)).toBeTruthy(), WAIT)
  })

  // Review 3 — the "told after 7am" toast asks the manager to ring the
  // coaches, so it stays until they dismiss it (the error toast's rule), where
  // an ordinary success or warning toast times out.
  it('the quiet-hours toast stays up until dismissed', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      replaceAnswers = [okResponse({ success: true, data: { notice: 'morning' } })]
      await openReplacePicker()
      fireEvent.click(screen.getByText('Coach B').closest('label').querySelector('input'))
      fireEvent.click(screen.getByRole('button', { name: 'Replace with Coach B' }))
      await waitFor(() => expect(screen.getByText(/at or before 7am, ring them/)).toBeTruthy(), WAIT)
      await act(async () => { await vi.advanceTimersByTimeAsync(30000) })
      expect(screen.getByText(/at or before 7am, ring them/)).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: 'Dismiss this message' }))
      expect(screen.queryByText(/at or before 7am, ring them/)).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('the ordinary "have been told" toast still times out', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      await openReplacePicker()
      fireEvent.click(screen.getByText('Coach B').closest('label').querySelector('input'))
      fireEvent.click(screen.getByRole('button', { name: 'Replace with Coach B' }))
      await waitFor(() => expect(screen.getByText(/have been told/)).toBeTruthy(), WAIT)
      await act(async () => { await vi.advanceTimersByTimeAsync(6001) })
      expect(screen.queryByText(/have been told/)).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('declining the clash sends nothing more and keeps the picker open', async () => {
    window.confirm = vi.fn(() => false)
    replaceAnswers = [okResponse({ success: false, code: 'swap_conflicts', error: 'x', conflicts: [{ kind: 'leave', message: 'Coach B has approved holiday.' }] }, 409)]
    await openReplacePicker()
    fireEvent.click(screen.getByText('Coach B').closest('label').querySelector('input'))
    fireEvent.click(screen.getByRole('button', { name: 'Replace with Coach B' }))
    await waitFor(() => expect(window.confirm).toHaveBeenCalled(), WAIT)
    expect(replaceCalls()).toHaveLength(1)
    expect(screen.getByText('Pick the coach who takes this shift')).toBeTruthy()
  })

  it('a refusal is shown in the server\'s words and keeps the picker open', async () => {
    replaceAnswers = [okResponse({ success: false, code: 'shift_started', error: 'This shift has already started.' }, 409)]
    await openReplacePicker()
    fireEvent.click(screen.getByText('Coach B').closest('label').querySelector('input'))
    fireEvent.click(screen.getByRole('button', { name: 'Replace with Coach B' }))
    await waitFor(() => expect(screen.getByText('This shift has already started.')).toBeTruthy(), WAIT)
    expect(screen.getByText('Pick the coach who takes this shift')).toBeTruthy()
  })
})
