// @vitest-environment jsdom
//
// MCPEMAIL.1 — the approve page's one button. It posts once, is disabled while
// posting and after success, and shows the outcome inline.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import CampaignApproveForm from './CampaignApproveForm'

const TOKEN = 'tok_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG'
let fetchMock

const answer = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body })

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('CampaignApproveForm', () => {
  it('posts once, disables the button, and shows the scheduled time or "queued"', async () => {
    let release
    fetchMock.mockReturnValue(new Promise((r) => { release = r }))
    render(<CampaignApproveForm token={TOKEN} label="Send to 104 people now" whenLabel={null} />)
    const button = screen.getByRole('button', { name: 'Send to 104 people now' })
    fireEvent.click(button)
    fireEvent.click(button)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe(`/api/communications/campaigns/approve/${TOKEN}`)
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'POST' })
    expect(button.disabled).toBe(true)
    release(answer(200, { success: true, data: { status: 'queued', scheduled_at: null } }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/queued/i))
    expect(button.disabled).toBe(true)
    fireEvent.click(button)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    cleanup()
    fetchMock.mockResolvedValue(answer(200, { success: true, data: { status: 'scheduled', scheduled_at: '2026-11-13T09:00:00.000Z' } }))
    render(<CampaignApproveForm token={TOKEN} label="Schedule for Fri 13 Nov 2026, 09:00" whenLabel="Fri 13 Nov 2026, 09:00 (Europe/Dublin)" />)
    const scheduleButton = screen.getByRole('button')
    fireEvent.click(scheduleButton)
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/Scheduled for Fri 13 Nov 2026, 09:00 \(Europe\/Dublin\)/))
    expect(scheduleButton.disabled).toBe(true)
  })

  it('shows a refusal inline and lets the person try again', async () => {
    fetchMock.mockResolvedValue(answer(409, { success: false, error: 'This campaign has changed since the test was sent. Ask Claude to send a new test.' }))
    render(<CampaignApproveForm token={TOKEN} label="Send to 104 people now" whenLabel={null} />)
    const button = screen.getByRole('button')
    fireEvent.click(button)
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/changed since the test/))
    expect(button.disabled).toBe(false)
  })

  // APPROVECOPY.1 — opening the page sends nothing; the page must say so. The
  // notice stays until the press succeeds, then gives way to the outcome.
  it('shows the "nothing has been sent yet" notice until the press succeeds', async () => {
    const NOTICE = 'Nothing has been sent yet. Press the button below to send it.'
    let release
    fetchMock.mockReturnValue(new Promise((r) => { release = r }))
    render(<CampaignApproveForm token={TOKEN} label="Send to 1 person now" whenLabel={null} notice={NOTICE} />)
    expect(screen.getByText(NOTICE)).toBeTruthy()
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByText(NOTICE)).toBeTruthy()
    release(answer(200, { success: true, data: { status: 'queued', scheduled_at: null } }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/queued/i))
    expect(screen.queryByText(NOTICE)).toBeNull()
  })

  it('keeps the notice after a refusal, since nothing was sent', async () => {
    const NOTICE = 'Nothing has been sent yet. Press the button below to send it.'
    fetchMock.mockResolvedValue(answer(409, { success: false, error: 'Nothing was sent. Ask Claude to send a new test.' }))
    render(<CampaignApproveForm token={TOKEN} label="Send to 1 person now" whenLabel={null} notice={NOTICE} />)
    fireEvent.click(screen.getByRole('button'))
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
    expect(screen.getByText(NOTICE)).toBeTruthy()
  })

  it('the button has type="button"', () => {
    render(<CampaignApproveForm token={TOKEN} label="Send to 104 people now" whenLabel={null} />)
    expect(screen.getByRole('button').getAttribute('type')).toBe('button')
  })
})
