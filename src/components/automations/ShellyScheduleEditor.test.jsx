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
