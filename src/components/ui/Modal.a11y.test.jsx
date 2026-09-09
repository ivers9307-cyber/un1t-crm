// @vitest-environment jsdom
//
// ROSTER-FIX.6b — the schedule's eight bespoke overlays move onto this
// primitive, so the primitive has to carry the dialog contract they were
// missing: focus stays inside while it is open, focus goes BACK to the
// control that opened it when it closes, and a half-filled form is not
// thrown away by a stray click on the backdrop.
//
// Modal already had role/aria-modal/aria-labelledby, Escape, and
// focus-on-open (UI-FOUND.2 + UI-MODAL-FOCUS.1). The three gaps closed here
// are the trap, the restore, and `dismissOnBackdrop` — which is NOT the same
// prop as `dismissable`: `dismissable={false}` also removes the close button
// and disables Escape, which would leave a dirty form with no way out at all.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'
import { useState } from 'react'
import { Modal } from '@/components/ui'

afterEach(cleanup)

function Harness({ dismissOnBackdrop, onClose }) {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <button type="button" onClick={() => setOpen(true)}>Open the thing</button>
      <Modal
        open={open}
        dismissOnBackdrop={dismissOnBackdrop}
        onClose={() => { setOpen(false); onClose?.() }}
        title="The thing"
      >
        <input aria-label="First" />
        <input aria-label="Second" />
      </Modal>
    </div>
  )
}

describe('Modal focus trap + restore (ROSTER-FIX.6b)', () => {
  it('returns focus to the trigger when it closes', () => {
    render(<Harness />)
    const trigger = screen.getByRole('button', { name: 'Open the thing' })
    trigger.focus()
    fireEvent.click(trigger)

    expect(screen.getByRole('dialog')).toBeTruthy()
    // Escape closes; focus must land back on the control that opened it,
    // not on document.body (which drops a keyboard user at the top of the page).
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('wraps Tab from the last focusable back to the first', () => {
    render(<Modal open onClose={() => {}} title="t"><input aria-label="First" /><input aria-label="Second" /></Modal>)
    const second = screen.getByLabelText('Second')
    second.focus()
    fireEvent.keyDown(document, { key: 'Tab' })
    // First focusable inside the panel is the header close button.
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }))
  })

  it('wraps Shift+Tab from the first focusable back to the last', () => {
    render(<Modal open onClose={() => {}} title="t"><input aria-label="First" /><input aria-label="Second" /></Modal>)
    screen.getByRole('button', { name: 'Close' }).focus()
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(screen.getByLabelText('Second'))
  })

  it('moves focus to the first focusable when Tab is pressed on the panel itself', () => {
    render(<Modal open onClose={() => {}} title="t"><input aria-label="First" /></Modal>)
    expect(document.activeElement).toBe(screen.getByRole('dialog'))
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }))
  })

  it('dismissOnBackdrop={false} keeps a backdrop click from closing a dirty form', () => {
    const onClose = vi.fn()
    render(<Harness dismissOnBackdrop={false} onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: 'Open the thing' }))

    const dialog = screen.getByRole('dialog')
    fireEvent.mouseDown(dialog.parentElement)
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toBeTruthy()

    // …but the operator still has both deliberate exits.
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('still closes on a backdrop click by default', () => {
    const onClose = vi.fn()
    render(<Harness onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: 'Open the thing' }))
    fireEvent.mouseDown(screen.getByRole('dialog').parentElement)
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
