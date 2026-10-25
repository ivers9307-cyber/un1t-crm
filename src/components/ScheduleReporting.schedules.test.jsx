// @vitest-environment jsdom
//
// REPORTS.2 — scheduled reports can be paused, resumed, edited and deleted;
// the delivery options say what they do; a staff cost schedule asks before
// emailing an address outside the team.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, screen, act, fireEvent } from '@testing-library/react'

import ScheduleReporting from '@/components/ScheduleReporting'

afterEach(cleanup)

const MANAGER = { id: 'm', role: 'manager', profileRole: 'manager', rolesByLocation: { loc1: 'manager' }, activeLocation: { id: 'loc1', name: 'Stillorgan' } }
const json = (body, status = 200) => Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) })

const SCHEDULE = {
  id: 'sch-1', location_id: 'loc1', report_type: 'staff_cost', report_name: 'Monthly cost', frequency: 'monthly',
  day_of_week: null, day_of_month: 1, deliver_email: true, email_recipients: ['accounts@firm.ie'],
  active: true, paused: false, next_run_at: '2026-10-01T07:00:00Z',
}

async function renderWith(fetchImpl) {
  global.fetch = vi.fn(fetchImpl)
  await act(async () => { render(<ScheduleReporting user={MANAGER} />) })
}

describe('ScheduleReporting — scheduled list actions', () => {
  it('pauses a schedule with PATCH { paused: true }', async () => {
    await renderWith((url, opts) => {
      if (opts?.method === 'PATCH') return json({ success: true, data: { ...SCHEDULE, paused: true } })
      if (String(url).includes('/scheduled')) return json({ success: true, data: [SCHEDULE] })
      return json({ success: true, data: [] })
    })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Scheduled \(1\)/ })) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Pause/ })) })
    const patch = global.fetch.mock.calls.find(([, o]) => o?.method === 'PATCH')
    expect(patch[0]).toBe('/api/schedule/reports/scheduled?id=sch-1')
    expect(JSON.parse(patch[1].body)).toEqual({ paused: true })
  })

  it('shows Paused and offers Resume for a paused schedule', async () => {
    await renderWith((url) => json({ success: true, data: String(url).includes('/scheduled') ? [{ ...SCHEDULE, paused: true }] : [] }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Scheduled \(1\)/ })) })
    expect(screen.getByText('Paused')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Resume/ })).toBeTruthy()
  })

  it('asks before deleting, then sends DELETE', async () => {
    await renderWith((url, opts) => {
      if (opts?.method === 'DELETE') return json({ success: true })
      return json({ success: true, data: String(url).includes('/scheduled') ? [SCHEDULE] : [] })
    })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Scheduled \(1\)/ })) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Delete Monthly cost' })) })
    expect(global.fetch.mock.calls.some(([, o]) => o?.method === 'DELETE')).toBe(false)
    expect(screen.getByText('Delete this schedule?')).toBeTruthy()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Delete' })) })
    expect(global.fetch.mock.calls.some(([u, o]) => o?.method === 'DELETE' && u.includes('id=sch-1'))).toBe(true)
  })
})

describe('ScheduleReporting — schedule modal', () => {
  it('offers "Email summary" and no in-app notification', async () => {
    await renderWith(() => json({ success: true, data: [] }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Staff Hours Worked/ })) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^Schedule$/ })) })
    expect(screen.getByText('Email summary')).toBeTruthy()
    expect(screen.queryByText(/In-app notification/)).toBeNull()
    expect(screen.queryByText(/PDF/)).toBeNull()
  })

  it('edits with PATCH, and confirms external staff cost recipients before re-saving', async () => {
    const patches = []
    await renderWith((url, opts) => {
      if (opts?.method === 'PATCH') {
        const body = JSON.parse(opts.body)
        patches.push(body)
        if (!body.confirm_external) {
          return json({ success: false, code: 'confirm_external_recipients', error: 'confirm', external_recipients: ['new@firm.ie'] }, 409)
        }
        return json({ success: true, data: SCHEDULE })
      }
      return json({ success: true, data: String(url).includes('/scheduled') ? [SCHEDULE] : [] })
    })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Scheduled \(1\)/ })) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Edit/ })) })
    expect(screen.getByDisplayValue('accounts@firm.ie')).toBeTruthy()
    fireEvent.change(screen.getByDisplayValue('accounts@firm.ie'), { target: { value: 'accounts@firm.ie, new@firm.ie' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save Changes' })) })

    expect(patches[0]).not.toHaveProperty('confirm_external')
    expect(patches[0]).not.toHaveProperty('deliver_notification')
    expect(screen.getByRole('alertdialog', { name: 'Confirm external recipients' })).toBeTruthy()
    expect(screen.getByText('new@firm.ie')).toBeTruthy()

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Confirm and save' })) })
    expect(patches[1]).toMatchObject({ confirm_external: true, email_recipients: ['accounts@firm.ie', 'new@firm.ie'] })
  })
})
