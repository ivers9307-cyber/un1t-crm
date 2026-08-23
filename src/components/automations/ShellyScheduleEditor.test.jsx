// @vitest-environment jsdom
//
// SHELLY-UI.6 — the schedule editor's one real contract: it PATCHes ONLY what
// changed. `ShellyDevicePatch` writes every field it is handed, so a save that
// sent the whole draft would rewrite `class_rule` — and its engine defaults for
// lead/lag — every time somebody nudged a window.
//
// The overlap and same-boundary rules are deliberately NOT checked here; they
// run on the server so the operator gets the answer the engine will act on, and
// the 400 arrives with the sentence in issues[0].message.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { DEFAULT_LEAD_MIN, DEFAULT_LAG_MIN, MAX_CLASS_LEAD_LAG_MIN } from '@/lib/shelly/schemas'
import ShellyScheduleEditor from './ShellyScheduleEditor.jsx'

const device = (over = {}) => ({
  id: 'row-1',
  schedule_mode: 'fixed',
  fixed_windows: [{ days: [1, 2, 3, 4, 5], on: '06:00', off: '21:00' }],
  class_rule: { lead_min: DEFAULT_LEAD_MIN, lag_min: DEFAULT_LAG_MIN },
  ...over,
})

const ok = () => ({ ok: true, json: { success: true } })

beforeEach(() => { vi.clearAllMocks() })
afterEach(cleanup)

// SHELLY-UI.9b — the editor is the OTHER control that can stop a schedule
// managing a relay: setting the mode to 'none' on an enabled device hits the
// same planner rule 2 that `enabled:false` does, and the relay stays exactly
// where it was left. The route answers a `notice` for both arms now; this is
// the half that surfaces it. Without it the one control that can abandon a
// plug said "Saved" and nothing else.
describe('ShellyScheduleEditor — the relay-stays notice', () => {
  it('surfaces the route’s notice after a save that stopped managing the relay', async () => {
    const notice = 'Schedule switched off — the plug stays as it is until you toggle it'
    const onSave = vi.fn(async () => ({ ok: true, json: { success: true, notice } }))
    render(<ShellyScheduleEditor device={device()} glofoxConnected onSave={onSave} />)
    fireEvent.click(screen.getByLabelText('No schedule'))
    fireEvent.click(screen.getByRole('button', { name: /Save schedule/ }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain(notice))
  })

  it('says nothing when the route sent no notice', async () => {
    const onSave = vi.fn(async () => ok())
    render(<ShellyScheduleEditor device={device()} glofoxConnected onSave={onSave} />)
    fireEvent.click(screen.getByLabelText('No schedule'))
    fireEvent.click(screen.getByRole('button', { name: /Save schedule/ }))
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('clears a stale notice when the next save carries none', async () => {
    const notice = 'Schedule switched off — the plug stays as it is until you toggle it'
    let next = { ok: true, json: { success: true, notice } }
    const onSave = vi.fn(async () => next)
    render(<ShellyScheduleEditor device={device()} glofoxConnected onSave={onSave} />)
    fireEvent.click(screen.getByLabelText('No schedule'))
    fireEvent.click(screen.getByRole('button', { name: /Save schedule/ }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain(notice))
    // A second, still-dirty save that abandons nothing must not leave the
    // previous warning standing over it.
    next = ok()
    fireEvent.click(screen.getByLabelText('Class timetable'))
    fireEvent.click(screen.getByRole('button', { name: /Save schedule/ }))
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2))
    expect(screen.queryByRole('status')).toBeNull()
  })
})

describe('ShellyScheduleEditor — the diff', () => {
  it('Save is dead until something changes', () => {
    render(<ShellyScheduleEditor device={device()} glofoxConnected onSave={vi.fn()} />)
    expect(screen.getByRole('button', { name: /Save schedule/ }).disabled).toBe(true)
  })

  it('a mode change sends schedule_mode ALONE — not the class rule beside it', async () => {
    const onSave = vi.fn(async () => ok())
    render(<ShellyScheduleEditor device={device()} glofoxConnected onSave={onSave} />)
    fireEvent.click(screen.getByLabelText('No schedule'))
    fireEvent.click(screen.getByRole('button', { name: /Save schedule/ }))
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ schedule_mode: 'none' }))
  })

  it('a window edit sends fixed_windows alone', async () => {
    const onSave = vi.fn(async () => ok())
    render(<ShellyScheduleEditor device={device()} glofoxConnected onSave={onSave} />)
    const times = document.querySelectorAll('input[type="time"]')
    fireEvent.change(times[1], { target: { value: '20:00' } })
    fireEvent.click(screen.getByRole('button', { name: /Save schedule/ }))
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({
      fixed_windows: [{ days: [1, 2, 3, 4, 5], on: '06:00', off: '20:00' }],
    }))
  })

  it('switching to class mode sends the rule with the mode, but only once it differs', async () => {
    const onSave = vi.fn(async () => ok())
    render(<ShellyScheduleEditor device={device()} glofoxConnected onSave={onSave} />)
    fireEvent.click(screen.getByLabelText('Class timetable'))
    fireEvent.click(screen.getByRole('button', { name: /Save schedule/ }))
    // The rule matched what is stored, so it does not travel.
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ schedule_mode: 'class' }))
  })

  it('a lead/lag edit sends class_rule with BOTH halves', async () => {
    const onSave = vi.fn(async () => ok())
    render(<ShellyScheduleEditor device={device({ schedule_mode: 'class' })} glofoxConnected onSave={onSave} />)
    fireEvent.change(screen.getByDisplayValue(String(DEFAULT_LEAD_MIN)), { target: { value: '25' } })
    fireEvent.click(screen.getByRole('button', { name: /Save schedule/ }))
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({
      class_rule: { lead_min: 25, lag_min: DEFAULT_LAG_MIN },
    }))
  })

  it('clamps a lead/lag beyond the engine bound rather than posting it', async () => {
    const onSave = vi.fn(async () => ok())
    render(<ShellyScheduleEditor device={device({ schedule_mode: 'class' })} glofoxConnected onSave={onSave} />)
    fireEvent.change(screen.getByDisplayValue(String(DEFAULT_LEAD_MIN)), { target: { value: '9999' } })
    fireEvent.click(screen.getByRole('button', { name: /Save schedule/ }))
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({
      class_rule: { lead_min: MAX_CLASS_LEAD_LAG_MIN, lag_min: DEFAULT_LAG_MIN },
    }))
  })

  it('a device with no stored class_rule falls back to the engine defaults, not to zero', () => {
    render(<ShellyScheduleEditor device={device({ schedule_mode: 'class', class_rule: {} })} glofoxConnected onSave={vi.fn()} />)
    expect(screen.getByDisplayValue(String(DEFAULT_LEAD_MIN))).toBeTruthy()
    expect(screen.getByDisplayValue(String(DEFAULT_LAG_MIN))).toBeTruthy()
  })
})

describe('ShellyScheduleEditor — Glofox gating', () => {
  it('class mode is unpickable without Glofox, and says why', () => {
    render(<ShellyScheduleEditor device={device()} glofoxConnected={false} onSave={vi.fn()} />)
    const radio = screen.getByLabelText('Class timetable')
    expect(radio.disabled).toBe(true)
    expect(radio.closest('label').getAttribute('title')).toBe('Connect Glofox to use class-linked schedules')
  })

  it('a device ALREADY in class mode still shows its inputs, disabled, with the reason', () => {
    render(<ShellyScheduleEditor device={device({ schedule_mode: 'class' })} glofoxConnected={false} onSave={vi.fn()} />)
    const lead = screen.getByDisplayValue(String(DEFAULT_LEAD_MIN))
    expect(lead.disabled).toBe(true)
    expect(lead.getAttribute('title')).toBe('Connect Glofox to use class-linked schedules')
    expect(screen.getByText('Connect Glofox to use class-linked schedules.')).toBeTruthy()
  })
})

describe('ShellyScheduleEditor — keyboard', () => {
  it('Enter in a lead field saves', async () => {
    const onSave = vi.fn(async () => ok())
    render(<ShellyScheduleEditor device={device({ schedule_mode: 'class' })} glofoxConnected onSave={onSave} />)
    const lead = screen.getByDisplayValue(String(DEFAULT_LEAD_MIN))
    fireEvent.change(lead, { target: { value: '30' } })
    fireEvent.keyDown(lead, { key: 'Enter' })
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({
      class_rule: { lead_min: 30, lag_min: DEFAULT_LAG_MIN },
    }))
  })

  it('Enter on an unchanged field sends nothing', () => {
    const onSave = vi.fn(async () => ok())
    render(<ShellyScheduleEditor device={device({ schedule_mode: 'class' })} glofoxConnected onSave={onSave} />)
    fireEvent.keyDown(screen.getByDisplayValue(String(DEFAULT_LEAD_MIN)), { key: 'Enter' })
    expect(onSave).not.toHaveBeenCalled()
  })

  it('Escape puts the field back to what is stored', () => {
    const onSave = vi.fn(async () => ok())
    render(<ShellyScheduleEditor device={device({ schedule_mode: 'class' })} glofoxConnected onSave={onSave} />)
    const lag = screen.getByDisplayValue(String(DEFAULT_LAG_MIN))
    fireEvent.change(lag, { target: { value: '99' } })
    expect(screen.getByRole('button', { name: /Save schedule/ }).disabled).toBe(false)
    fireEvent.keyDown(lag, { key: 'Escape' })
    expect(screen.getByDisplayValue(String(DEFAULT_LAG_MIN))).toBeTruthy()
    expect(screen.getByRole('button', { name: /Save schedule/ }).disabled).toBe(true)
    expect(onSave).not.toHaveBeenCalled()
  })
})

describe('ShellyScheduleEditor — saving', () => {
  it('renders the server’s refusal and stays dirty', async () => {
    const onSave = vi.fn(async () => ({ ok: false, message: 'Windows must not overlap: 06:00–21:00 and 20:00–22:00' }))
    render(<ShellyScheduleEditor device={device()} glofoxConnected onSave={onSave} />)
    fireEvent.click(screen.getByLabelText('No schedule'))
    fireEvent.click(screen.getByRole('button', { name: /Save schedule/ }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('must not overlap'))
    expect(screen.queryByText('Saved')).toBeNull()
  })

  it('confirms a save once the draft and the row agree again', async () => {
    const onSave = vi.fn(async () => ok())
    const { rerender } = render(<ShellyScheduleEditor device={device()} glofoxConnected onSave={onSave} />)
    fireEvent.click(screen.getByLabelText('No schedule'))
    fireEvent.click(screen.getByRole('button', { name: /Save schedule/ }))
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    // The parent reloads and hands back the saved row.
    rerender(<ShellyScheduleEditor device={device({ schedule_mode: 'none' })} glofoxConnected onSave={onSave} />)
    expect(screen.getByText('Saved')).toBeTruthy()
  })
})
