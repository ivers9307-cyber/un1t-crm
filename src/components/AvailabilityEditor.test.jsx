// @vitest-environment jsdom
//
// AVAIL.1 — a coach edits their own availability on the web: loads it, adds
// weekly times and dates, is told what is wrong before a save, and the save
// sends exactly the lists on screen.

import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import AvailabilityEditor from './AvailabilityEditor.jsx'

const TODAY = '2026-09-25'
const MON = { kind: 'weekly', weekday: 'mon', start_date: null, end_date: null, all_day: false, start_time: '09:00', end_time: '12:00', note: null }
const ok = (body, status = 200) => ({ ok: status < 400, status, json: async () => body })

let putBody = null
let putCount = 0
beforeEach(() => {
  putBody = null
  putCount = 0
  global.fetch = vi.fn(async (url, options) => {
    if (options?.method === 'PUT') {
      putCount += 1
      putBody = JSON.parse(options.body)
      return ok({ success: true, data: { changed: true, weekly: [MON, { ...MON, weekday: 'tue', all_day: true, start_time: null, end_time: null }], dated: [] } })
    }
    return ok({ success: true, data: { weekly: [MON], dated: [] } })
  })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('AvailabilityEditor', () => {
  it('shows what is saved', async () => {
    render(<AvailabilityEditor todayIso={TODAY} />)
    const day = await screen.findByLabelText('Day of the week')
    expect(day.value).toBe('mon')
    expect(screen.getByLabelText('From').value).toBe('09:00')
    expect(screen.getByLabelText('To').value).toBe('12:00')
    expect(screen.getByText(/Your managers can see your notes/)).toBeTruthy()
    expect(global.fetch.mock.calls[0][0]).toBe('/api/schedule/availability')
  })

  it('adds a weekly time and saves exactly the lists on screen', async () => {
    render(<AvailabilityEditor todayIso={TODAY} />)
    await screen.findByLabelText('Day of the week')
    fireEvent.click(screen.getByRole('button', { name: 'Add a weekly time' }))
    const days = screen.getAllByLabelText('Day of the week')
    fireEvent.change(days[1], { target: { value: 'tue' } })
    fireEvent.click(screen.getAllByLabelText('All day')[1])
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await screen.findByText('Saved. Your managers will get a notification.')
    expect(putBody).toEqual({
      weekly: [
        { weekday: 'mon', all_day: false, start_time: '09:00', end_time: '12:00', note: null },
        { weekday: 'tue', all_day: true, start_time: null, end_time: null, note: null },
      ],
      dated: [],
    })
  })

  it('a save that changes nothing says so', async () => {
    global.fetch = vi.fn(async (url, options) => (options?.method === 'PUT'
      ? ok({ success: true, data: { changed: false, weekly: [MON], dated: [] } })
      : ok({ success: true, data: { weekly: [MON], dated: [] } })))
    render(<AvailabilityEditor todayIso={TODAY} />)
    await screen.findByLabelText('Day of the week')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await screen.findByText('Nothing changed.')
  })

  it('says what is wrong and does not save', async () => {
    render(<AvailabilityEditor todayIso={TODAY} />)
    await screen.findByLabelText('Day of the week')
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '08:00' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await screen.findByText('The end time must be after the start time')
    expect(putCount).toBe(0)
  })

  it('adds a date, one day, all day by default, starting today', async () => {
    render(<AvailabilityEditor todayIso={TODAY} />)
    await screen.findByLabelText('Day of the week')
    fireEvent.click(screen.getByRole('button', { name: 'Add a date' }))
    expect(screen.getByLabelText('First day').value).toBe(TODAY)
    expect(screen.getByLabelText('Last day').value).toBe(TODAY)
    fireEvent.change(screen.getAllByLabelText('Note')[1], { target: { value: 'Wedding' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(putBody).not.toBeNull())
    expect(putBody.dated).toEqual([{ start_date: TODAY, end_date: TODAY, all_day: true, start_time: null, end_time: null, note: 'Wedding' }])
  })

  it('a removed row is not sent', async () => {
    render(<AvailabilityEditor todayIso={TODAY} />)
    await screen.findByLabelText('Day of the week')
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    expect(screen.queryByLabelText('Day of the week')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(putBody).not.toBeNull())
    expect(putBody).toEqual({ weekly: [], dated: [] })
  })

  // AVAIL.1a's started-rule contract (shared/availability.js
  // carryStartedRules): the client judges with the same knownKeys the route
  // does, so what it lets through is what the server accepts.
  describe('a dated rule that has already started', () => {
    const STARTED = { kind: 'dated', weekday: null, start_date: '2026-09-20', end_date: '2026-09-30', all_day: true, start_time: null, end_time: null, note: 'Away' }
    beforeEach(() => {
      const base = global.fetch
      global.fetch = vi.fn(async (url, options) => (options?.method === 'PUT'
        ? base(url, options)
        : ok({ success: true, data: { weekly: [], dated: [STARTED] } })))
    })

    it('says it has started, and only its last day and note can change', async () => {
      render(<AvailabilityEditor todayIso={TODAY} />)
      await screen.findByLabelText('Last day')
      expect(screen.getByText(/Started 20 Sep/)).toBeTruthy()
      expect(screen.getByLabelText('First day').disabled).toBe(true)
      expect(screen.getByLabelText('All day').disabled).toBe(true)
      expect(screen.getByLabelText('Last day').disabled).toBe(false)
      expect(screen.getByLabelText('Note').disabled).toBe(false)
    })

    it('moving only its end saves it with its stored start (the server carries it from today)', async () => {
      render(<AvailabilityEditor todayIso={TODAY} />)
      fireEvent.change(await screen.findByLabelText('Last day'), { target: { value: '2026-09-27' } })
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
      await waitFor(() => expect(putBody).not.toBeNull())
      expect(putBody.dated).toEqual([{ start_date: '2026-09-20', end_date: '2026-09-27', all_day: true, start_time: null, end_time: null, note: 'Away' }])
    })
  })

  it('a new date may not start before today (no backdating), and is not sent', async () => {
    render(<AvailabilityEditor todayIso={TODAY} />)
    await screen.findByLabelText('Day of the week')
    fireEvent.click(screen.getByRole('button', { name: 'Add a date' }))
    fireEvent.change(screen.getByLabelText('First day'), { target: { value: '2026-09-24' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await screen.findByText('Start today or later')
    expect(putCount).toBe(0)
  })

  it("shows the server's issues when it refuses", async () => {
    global.fetch = vi.fn(async (url, options) => (options?.method === 'PUT'
      ? ok({ success: false, error: 'Invalid availability', issues: [{ path: 'dated.0', message: 'That date has passed' }] }, 400)
      : ok({ success: true, data: { weekly: [MON], dated: [] } })))
    render(<AvailabilityEditor todayIso={TODAY} />)
    await screen.findByLabelText('Day of the week')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await screen.findByText('That date has passed')
  })

  it('says so when it cannot load, instead of an empty editor', async () => {
    global.fetch = vi.fn(async () => ok({ success: false, error: 'Could not load your availability' }, 500))
    render(<AvailabilityEditor todayIso={TODAY} />)
    await screen.findByText('Could not load your availability')
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
  })
})
