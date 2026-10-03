// @vitest-environment jsdom
// BLOCKEDIT.1 — the manager's form for one shift. Text, roles and payloads
// only (memory `jsdom-cannot-see-layout`).
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import BlockEditForm from './BlockEditForm'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const BLOCK = {
  id: 'b1', start_time: '09:00:00', end_time: '12:00:00', min_coaches: 1, max_coaches: 3, briefing: null,
  shift_templates: { name: 'Morning', kind: 'class' },
}

// Review fix 2 — every save carries the values the form opened with.
const OPENED = { start_time: '09:00', end_time: '12:00', min_coaches: 1, max_coaches: 3 }

async function save() {
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save shift' })) })
}

describe('BlockEditForm', () => {
  it("starts from the shift's own values", () => {
    render(<BlockEditForm block={{ ...BLOCK, briefing: 'Old note' }} onSave={vi.fn()} onDone={vi.fn()} />)
    expect(screen.getByLabelText('Start').value).toBe('09:00')
    expect(screen.getByLabelText('End').value).toBe('12:00')
    expect(screen.getByLabelText('Minimum coaches').value).toBe('1')
    expect(screen.getByLabelText('Maximum coaches').value).toBe('3')
    expect(screen.getByLabelText('Briefing for the coaches').value).toBe('Old note')
    expect(screen.getByText('8/500')).toBeTruthy()
  })

  it('sends only what changed', async () => {
    const onSave = vi.fn(async () => ({ ok: true }))
    const onDone = vi.fn()
    render(<BlockEditForm block={BLOCK} onSave={onSave} onDone={onDone} />)
    fireEvent.change(screen.getByLabelText('Start'), { target: { value: '09:30' } })
    fireEvent.change(screen.getByLabelText('Briefing for the coaches'), { target: { value: 'Fire drill at 10' } })
    await save()
    expect(onSave).toHaveBeenCalledWith({ start_time: '09:30', briefing: 'Fire drill at 10', expected: OPENED })
    expect(onDone).toHaveBeenCalled()
  })

  it('nothing changed: closes without a request', async () => {
    const onSave = vi.fn()
    const onDone = vi.fn()
    render(<BlockEditForm block={BLOCK} onSave={onSave} onDone={onDone} />)
    await save()
    expect(onSave).not.toHaveBeenCalled()
    expect(onDone).toHaveBeenCalled()
  })

  it('emptying the briefing clears it (sends null)', async () => {
    const onSave = vi.fn(async () => ({ ok: true }))
    render(<BlockEditForm block={{ ...BLOCK, briefing: 'Old note' }} onSave={onSave} onDone={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('Briefing for the coaches'), { target: { value: '   ' } })
    await save()
    expect(onSave).toHaveBeenCalledWith({ briefing: null, expected: OPENED })
  })

  it('an admin shift has no minimum field to send', () => {
    render(<BlockEditForm block={{ ...BLOCK, min_coaches: 0, shift_templates: { name: 'Ops', kind: 'admin' } }} onSave={vi.fn()} onDone={vi.fn()} />)
    expect(screen.queryByLabelText('Minimum coaches')).toBeNull()
    expect(screen.getByText('Admin shifts have no minimum.')).toBeTruthy()
  })

  it('below the coaches on it: asks, and resends with allow_below_assigned on yes', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true))
    const onSave = vi.fn()
      .mockResolvedValueOnce({ ok: false, code: 'below_assigned', error: '2 coaches are on this shift, more than a maximum of 1.' })
      .mockResolvedValueOnce({ ok: true })
    const onDone = vi.fn()
    render(<BlockEditForm block={BLOCK} onSave={onSave} onDone={onDone} />)
    fireEvent.change(screen.getByLabelText('Maximum coaches'), { target: { value: '1' } })
    await save()
    expect(onSave).toHaveBeenLastCalledWith({ max_coaches: 1, expected: OPENED, allow_below_assigned: true })
    expect(onDone).toHaveBeenCalled()
  })

  it('shows the server refusal inline and stays open', async () => {
    const onSave = vi.fn(async () => ({ ok: false, error: 'A shift must end after it starts.' }))
    const onDone = vi.fn()
    render(<BlockEditForm block={BLOCK} onSave={onSave} onDone={onDone} />)
    fireEvent.change(screen.getByLabelText('End'), { target: { value: '08:00' } })
    await save()
    expect(screen.getByRole('alert').textContent).toBe('A shift must end after it starts.')
    expect(onDone).not.toHaveBeenCalled()
  })

  // Review fix 4 — a saved move that double-books someone is shown before
  // the form closes.
  it('saved with overlaps: lists them and closes only on Done', async () => {
    const onSave = vi.fn(async () => ({ ok: true, overlaps: [{ profile_id: 'u1', message: 'Coach A is already on Evening 13:00–15:00 that day — overlaps this shift.' }] }))
    const onDone = vi.fn()
    render(<BlockEditForm block={BLOCK} onSave={onSave} onDone={onDone} />)
    fireEvent.change(screen.getByLabelText('End'), { target: { value: '14:00' } })
    await save()
    expect(screen.getByRole('status').textContent).toMatch(/Coach A is already on Evening/)
    expect(onDone).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(onDone).toHaveBeenCalled()
  })

  // Review nit — a past shift's hours are paid hours.
  it('a past shift: asks, and resends with confirm_past on yes', async () => {
    const ask = vi.fn(() => true)
    vi.stubGlobal('confirm', ask)
    const onSave = vi.fn()
      .mockResolvedValueOnce({ ok: false, code: 'past_shift', error: 'This shift is in the past.' })
      .mockResolvedValueOnce({ ok: true })
    const onDone = vi.fn()
    render(<BlockEditForm block={BLOCK} onSave={onSave} onDone={onDone} />)
    fireEvent.change(screen.getByLabelText('End'), { target: { value: '13:00' } })
    await save()
    expect(ask).toHaveBeenCalledWith('This shift is in the past — change its hours anyway? Paid hours will change.')
    expect(onSave).toHaveBeenLastCalledWith({ end_time: '13:00', expected: OPENED, confirm_past: true })
    expect(onDone).toHaveBeenCalled()
  })

  it('a past shift: no on the question sends nothing more and stays open', async () => {
    vi.stubGlobal('confirm', vi.fn(() => false))
    const onSave = vi.fn().mockResolvedValueOnce({ ok: false, code: 'past_shift', error: 'This shift is in the past.' })
    const onDone = vi.fn()
    render(<BlockEditForm block={BLOCK} onSave={onSave} onDone={onDone} />)
    fireEvent.change(screen.getByLabelText('End'), { target: { value: '13:00' } })
    await save()
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onDone).not.toHaveBeenCalled()
  })

  // Second review 1 — the calendar reloads (after this form's own save, or
  // any refresh) and hands the form a NEW block. The form must still judge
  // "changed" and send `expected` from the values it OPENED with, or an
  // untouched field goes back as a change and undoes another manager's edit.
  it('a block swapped underneath the open form: sends only what the manager changed, expected = the opened values', async () => {
    const onSave = vi.fn(async () => ({ ok: true }))
    const { rerender } = render(<BlockEditForm block={BLOCK} onSave={onSave} onDone={vi.fn()} />)
    rerender(<BlockEditForm block={{ ...BLOCK, start_time: '08:00:00', max_coaches: 4 }} onSave={onSave} onDone={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('Briefing for the coaches'), { target: { value: 'Fire drill at 10' } })
    await save()
    expect(onSave).toHaveBeenCalledWith({ briefing: 'Fire drill at 10', expected: OPENED })
  })
})

