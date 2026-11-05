// @vitest-environment jsdom
// MIASETTINGS.2d — the one save bar.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import SaveBar from './SaveBar'

afterEach(() => { cleanup(); vi.useRealTimers() })
const base = { count: 0, holds: [], saving: false, savedAt: null, error: null, onSave: () => {}, onDiscard: () => {}, onGoTo: () => {} }

describe('SaveBar', () => {
  it('says how many unsaved changes there are', () => {
    const { rerender } = render(<SaveBar {...base} count={1} />)
    expect(screen.getByText('1 unsaved change')).toBeTruthy()
    rerender(<SaveBar {...base} count={3} />)
    expect(screen.getByText('3 unsaved changes')).toBeTruthy()
  })

  it('is out of sight when nothing is unsaved', () => {
    const { container } = render(<SaveBar {...base} />)
    expect(container.firstChild.className).toContain('sr-only')
    expect(screen.queryByText(/unsaved change/)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Discard' })).toBeNull()
  })

  it('Save and Discard call back; the label can change', () => {
    const onSave = vi.fn(); const onDiscard = vi.fn()
    render(<SaveBar {...base} count={2} onSave={onSave} onDiscard={onDiscard} saveLabel="Save studio" />)
    fireEvent.click(screen.getByRole('button', { name: 'Save studio' }))
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onDiscard).toHaveBeenCalledTimes(1)
  })

  it('holds disable Save and each opens its section', () => {
    const onGoTo = vi.fn()
    render(<SaveBar {...base} count={1} onGoTo={onGoTo}
      holds={[{ section: 'followups', message: 'Trial finisher needs a delay' }]} />)
    expect(screen.getByRole('button', { name: 'Save' }).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Trial finisher needs a delay in Follow-ups' }))
    expect(onGoTo).toHaveBeenCalledWith('followups')
  })

  it('shows the error and a saving state', () => {
    render(<SaveBar {...base} count={1} saving error="Failed to save" />)
    expect(screen.getByText('Failed to save')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Saving…' }).disabled).toBe(true)
  })

  it('shows Saved for four seconds after a save', async () => {
    vi.useFakeTimers()
    const { container } = render(<SaveBar {...base} savedAt={Date.now()} />)
    expect(screen.getByText('Saved')).toBeTruthy()
    expect(container.firstChild.className).not.toContain('sr-only')
    await act(async () => { await vi.advanceTimersByTimeAsync(3900) })
    expect(screen.getByText('Saved')).toBeTruthy()
    await act(async () => { await vi.advanceTimersByTimeAsync(200) })
    expect(screen.queryByText('Saved')).toBeNull()
  })
})
