// @vitest-environment jsdom
//
// UI-MODAL-FOCUS.1 — regression guard: an open Modal must not steal focus
// back to its panel on every re-render.
//
// The bug (operator-reported 2026-08-01, while entering equipment types):
// typing one character into any input inside a Modal moved focus out of the
// field, so the operator had to re-click after EVERY keystroke.
//
// Cause: the open-effect had `onClose` in its dependency array and ended with
// `panelRef.current?.focus()`. Every call site passes an inline arrow
// (`onClose={() => setEditing(null)}`), which is a new function identity on
// every render — so a keystroke → setState → re-render → new onClose → effect
// re-runs → focus jumps to the panel.
//
// This is a shared primitive: 8 call sites pass an inline onClose, four of
// them predating the feature that surfaced it. Fixing it here fixes every
// modal in the app.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, screen } from '@testing-library/react'
import { Modal } from '@/components/ui'

afterEach(cleanup)

function ModalWithInput({ onClose }) {
  return (
    <Modal open onClose={onClose} title="New equipment type">
      <input aria-label="Name" defaultValue="" />
    </Modal>
  )
}

describe('Modal focus behaviour', () => {
  it('moves focus into the dialog when it opens', () => {
    render(<ModalWithInput onClose={() => {}} />)
    expect(document.activeElement).toBe(screen.getByRole('dialog'))
  })

  it('does NOT steal focus back when re-rendered with a new onClose identity', () => {
    // Mirrors what every call site does: an inline arrow, so a fresh
    // function identity on each render.
    const { rerender } = render(<ModalWithInput onClose={() => {}} />)

    const input = screen.getByLabelText('Name')
    input.focus()
    expect(document.activeElement).toBe(input)

    // A keystroke in a real modal triggers setState in the parent, which
    // re-renders with a brand-new onClose. Focus must stay in the field.
    rerender(<ModalWithInput onClose={() => {}} />)
    expect(document.activeElement).toBe(input)

    // And must survive repeated renders — the operator typed many characters.
    rerender(<ModalWithInput onClose={() => {}} />)
    rerender(<ModalWithInput onClose={() => {}} />)
    expect(document.activeElement).toBe(input)
  })

  it('still closes on Escape using the LATEST onClose after a re-render', () => {
    // The fix keeps callbacks in a ref to drop them from the deps. That must
    // not staple the listener to the FIRST onClose it ever saw.
    const first = vi.fn()
    const latest = vi.fn()

    const { rerender } = render(<ModalWithInput onClose={first} />)
    rerender(<ModalWithInput onClose={latest} />)

    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }))

    expect(latest).toHaveBeenCalledTimes(1)
    expect(first).not.toHaveBeenCalled()
  })

  it('honours a dismissable change made after mount', () => {
    const onClose = vi.fn()
    const { rerender } = render(
      <Modal open onClose={onClose} dismissable title="t"><input aria-label="a" /></Modal>
    )
    rerender(
      <Modal open onClose={onClose} dismissable={false} title="t"><input aria-label="a" /></Modal>
    )

    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }))
    expect(onClose).not.toHaveBeenCalled()
  })
})
