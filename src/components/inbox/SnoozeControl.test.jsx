// @vitest-environment jsdom
// INBOXFOLLOW.2 — the Snooze control in a thread header.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor, act } from '@testing-library/react'
import SnoozeControl from './SnoozeControl.jsx'

const NOW = Date.parse('2026-11-25T12:00:00Z') // Wednesday
const reply = (body, ok = true, status = 200) => ({ ok, status, json: async () => body })
let fetchMock
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  fetchMock = vi.fn(async () => reply({ success: true, data: { snoozed_until: 'x', snooze_note: null } }))
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers() })

const bodyOf = (i = 0) => JSON.parse(fetchMock.mock.calls[i][1].body)
const open = () => fireEvent.click(screen.getByRole('button', { name: 'Snooze' }))
const conv = (extra = {}) => ({ id: 'c1', resolved_at: null, snoozed_until: null, ...extra })

describe('SnoozeControl', () => {
  it('a preset posts its instant and the note to the channel route, then refreshes', async () => {
    const onChanged = vi.fn()
    render(<SnoozeControl channel="wa" conversation={conv()} zone="Europe/Dublin" onChanged={onChanged} />)
    open()
    fireEvent.change(screen.getByLabelText(/Note/), { target: { value: 'ring Friday' } })
    fireEvent.click(screen.getByRole('button', { name: 'Tomorrow 09:00' }))
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
    expect(fetchMock.mock.calls[0][0]).toBe('/api/whatsapp/conversations/c1/snooze')
    expect(bodyOf()).toEqual({ until: '2026-11-26T09:00:00.000Z', note: 'ring Friday', seen_last_message_at: null })
  })

  it('Instagram posts to its own route', async () => {
    render(<SnoozeControl channel="ig" conversation={conv()} zone="Europe/Dublin" />)
    open()
    fireEvent.click(screen.getByRole('button', { name: 'Later today' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(fetchMock.mock.calls[0][0]).toBe('/api/instagram/conversations/c1/snooze')
  })

  it("reads the custom time on the studio's clock, not the browser's", async () => {
    render(<SnoozeControl channel="wa" conversation={conv()} zone="America/New_York" />)
    open()
    fireEvent.change(screen.getByLabelText(/Or pick a time/), { target: { value: '2026-11-27T09:00' } })
    fireEvent.click(screen.getByRole('button', { name: 'Snooze until then' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(bodyOf().until).toBe('2026-11-27T14:00:00.000Z') // 09:00 EST
  })

  it('asks for a time when the custom field is empty, and sends nothing', () => {
    render(<SnoozeControl channel="wa" conversation={conv()} zone="Europe/Dublin" />)
    open()
    fireEvent.click(screen.getByRole('button', { name: 'Snooze until then' }))
    expect(screen.getByRole('alert').textContent).toBe('Pick a date and a time.')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("shows the route's reason under the control, never an alert", async () => {
    const alertSpy = vi.fn()
    vi.stubGlobal('alert', alertSpy)
    fetchMock.mockResolvedValueOnce(reply({ success: false, error: 'Conversation is completed' }, false, 400))
    render(<SnoozeControl channel="wa" conversation={conv()} zone="Europe/Dublin" />)
    open()
    fireEvent.click(screen.getByRole('button', { name: 'In 3 days' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Conversation is completed'))
    expect(alertSpy).not.toHaveBeenCalled()
  })

  it('no answer shows a fixed message', async () => {
    fetchMock.mockRejectedValueOnce(new Error('offline'))
    render(<SnoozeControl channel="wa" conversation={conv()} zone="Europe/Dublin" />)
    open()
    fireEvent.click(screen.getByRole('button', { name: 'In 3 days' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Could not change the snooze. Try again.'))
  })

  it('a snoozed thread shows when it returns, with the note, in the studio zone; Unsnooze posts until null', async () => {
    const onChanged = vi.fn()
    render(<SnoozeControl channel="wa" conversation={conv({ snoozed_until: '2026-11-27T09:00:00.000Z', snooze_note: 'ring back' })} zone="Europe/Dublin" onChanged={onChanged} />)
    expect(screen.getByTestId('snoozed-state').textContent).toContain('Snoozed until Fri 27 Nov, 09:00 · ring back')
    expect(screen.queryByRole('button', { name: 'Snooze' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Unsnooze' }))
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
    expect(bodyOf()).toEqual({ until: null })
  })

  it('a snooze that has ended is not shown as snoozed', () => {
    render(<SnoozeControl channel="wa" conversation={conv({ snoozed_until: '2026-11-25T11:00:00.000Z' })} zone="Europe/Dublin" />)
    expect(screen.queryByTestId('snoozed-state')).toBeNull()
  })

  it('a snooze that has ended but is still set shows "Snooze ended · Dismiss" beside Snooze; Dismiss posts until null and refreshes', async () => {
    const onChanged = vi.fn()
    render(<SnoozeControl channel="wa" conversation={conv({ snoozed_until: '2026-11-25T11:00:00.000Z', snooze_note: 'ring back' })} zone="Europe/Dublin" onChanged={onChanged} />)
    expect(screen.getByTestId('snooze-ended').textContent).toContain('Snooze ended · ring back')
    expect(screen.getByRole('button', { name: 'Snooze' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
    expect(fetchMock.mock.calls[0][0]).toBe('/api/whatsapp/conversations/c1/snooze')
    expect(bodyOf()).toEqual({ until: null })
  })

  it('no Dismiss on a thread that was never snoozed or is snoozed now', () => {
    const { rerender } = render(<SnoozeControl channel="wa" conversation={conv()} zone="Europe/Dublin" />)
    expect(screen.queryByTestId('snooze-ended')).toBeNull()
    rerender(<SnoozeControl channel="wa" conversation={conv({ snoozed_until: '2026-11-27T09:00:00.000Z' })} zone="Europe/Dublin" />)
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull()
  })

  it('sends the last message the coach saw, so the route can refuse a message that landed since', async () => {
    render(<SnoozeControl channel="wa" conversation={conv({ last_message_at: '2026-11-25T11:30:00.000Z' })} zone="Europe/Dublin" />)
    open()
    fireEvent.click(screen.getByRole('button', { name: 'Later today' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(bodyOf().seen_last_message_at).toBe('2026-11-25T11:30:00.000Z')
  })

  it("shows the 409's message under the control", async () => {
    fetchMock.mockResolvedValueOnce(reply({ success: false, error: 'A new message arrived. Check it before snoozing.' }, false, 409))
    render(<SnoozeControl channel="wa" conversation={conv({ last_message_at: '2026-11-25T11:30:00.000Z' })} zone="Europe/Dublin" />)
    open()
    fireEvent.click(screen.getByRole('button', { name: 'Later today' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('A new message arrived. Check it before snoozing.'))
  })

  it('a 409 shows its message, keeps the popover open and refreshes the thread once; other errors do not refresh', async () => {
    const onChanged = vi.fn()
    fetchMock.mockResolvedValueOnce(reply({ success: false, error: 'A new message arrived. Check it before snoozing.' }, false, 409))
    render(<SnoozeControl channel="wa" conversation={conv()} zone="Europe/Dublin" onChanged={onChanged} />)
    open()
    fireEvent.click(screen.getByRole('button', { name: 'Later today' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('A new message arrived. Check it before snoozing.'))
    expect(onChanged).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('group', { name: 'Snooze this conversation' })).toBeTruthy()
    fetchMock.mockResolvedValueOnce(reply({ success: false, error: 'Conversation is completed' }, false, 400))
    fireEvent.click(screen.getByRole('button', { name: 'In 3 days' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Conversation is completed'))
    expect(onChanged).toHaveBeenCalledTimes(1)
  })

  it('Escape closes the popover and returns focus to the Snooze button', () => {
    render(<SnoozeControl channel="wa" conversation={conv()} zone="Europe/Dublin" />)
    open()
    expect(screen.getByRole('group', { name: 'Snooze this conversation' })).toBeTruthy()
    act(() => { fireEvent.keyDown(document, { key: 'Escape' }) })
    expect(screen.queryByRole('group', { name: 'Snooze this conversation' })).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Snooze' }))
  })

  it('a press outside closes the popover; a press inside does not', () => {
    render(<div><span data-testid="outside">elsewhere</span><SnoozeControl channel="wa" conversation={conv()} zone="Europe/Dublin" /></div>)
    open()
    fireEvent.mouseDown(screen.getByLabelText(/Note/))
    expect(screen.getByRole('group', { name: 'Snooze this conversation' })).toBeTruthy()
    fireEvent.mouseDown(screen.getByTestId('outside'))
    expect(screen.queryByRole('group', { name: 'Snooze this conversation' })).toBeNull()
  })

  it('every button is type="button"', () => {
    const { container } = render(<SnoozeControl channel="wa" conversation={conv()} zone="Europe/Dublin" />)
    open()
    for (const b of container.querySelectorAll('button')) expect(b.getAttribute('type')).toBe('button')
  })
})
