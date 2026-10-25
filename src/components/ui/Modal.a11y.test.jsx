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
import { useState, useRef } from 'react'
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

// ─── the trigger is gone by the time the dialog closes ────────────────
//
// ROSTER-FIX.6b-7. The restore above captures document.activeElement on open
// and focuses it again on close. That silently does nothing when the control
// has left the DOM in between — which is exactly what the schedule's two
// stacked flows do (Add-coach is clicked inside the block-detail dialog, which
// then hides; the swap icon closes that dialog outright). Focus stayed on
// document.body: the same bug the restore was written to fix, one flow deeper.

// A trigger that removes ITSELF when it opens the dialog.
function VanishingTrigger({ withRef }) {
  const [open, setOpen] = useState(false)
  const container = useRef(null)
  return (
    <div>
      <div ref={container} data-testid="container">
        {!open && <button type="button" onClick={() => setOpen(true)}>Vanishing trigger</button>}
      </div>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Second dialog"
        restoreFocusRef={withRef ? container : undefined}
      >
        <input aria-label="Only" />
      </Modal>
    </div>
  )
}

describe('Modal focus restore when the trigger unmounts (ROSTER-FIX.6b-7)', () => {
  it('lands on restoreFocusRef instead of document.body', () => {
    render(<VanishingTrigger withRef />)
    const trigger = screen.getByRole('button', { name: 'Vanishing trigger' })
    trigger.focus()
    fireEvent.click(trigger)
    expect(trigger.isConnected).toBe(false)

    fireEvent.keyDown(document, { key: 'Escape' })

    const container = screen.getByTestId('container')
    expect(document.activeElement).toBe(container)
    expect(document.activeElement).not.toBe(document.body)
    // The container is not a control: it takes the tabindex only for as long
    // as it holds focus, so it never joins the page's Tab order.
    expect(container.getAttribute('tabindex')).toBe('-1')
    fireEvent.blur(container)
    expect(container.getAttribute('tabindex')).toBeNull()
  })

  it('falls back to the page\u2019s main landmark when there is no ref either', () => {
    const main = document.createElement('main')
    document.body.appendChild(main)
    try {
      render(<VanishingTrigger />)
      fireEvent.click(screen.getByRole('button', { name: 'Vanishing trigger' }))
      fireEvent.keyDown(document, { key: 'Escape' })
      expect(document.activeElement).toBe(main)
    } finally {
      main.remove()
    }
  })

  it('still prefers the real trigger when it is still there', () => {
    // The fallback must not fire ahead of a perfectly good trigger.
    const main = document.createElement('main')
    document.body.appendChild(main)
    try {
      const container = { current: document.createElement('div') }
      document.body.appendChild(container.current)
      render(<Harness />)
      const trigger = screen.getByRole('button', { name: 'Open the thing' })
      trigger.focus()
      fireEvent.click(trigger)
      fireEvent.keyDown(document, { key: 'Escape' })
      expect(document.activeElement).toBe(trigger)
    } finally {
      main.remove()
    }
  })
})

// ─── nits: what the trap counts, and who owns Escape ──────────────────
describe('Modal focus trap ignores what cannot be focused (ROSTER-FIX.6b-9)', () => {
  it('skips a hidden input and a hidden control when wrapping', () => {
    render(
      <Modal open onClose={() => {}} title="t">
        <input aria-label="Real" />
        <input type="hidden" name="csrf" defaultValue="x" />
        <button type="button" hidden>Collapsed</button>
      </Modal>
    )
    // Both trailing nodes are unfocusable, so "Real" is the LAST rung of the
    // ring and Tab wraps to the close button. Before the filter the ring ended
    // on one of them and Tab simply lost the cursor.
    //
    // 🔴 The third exclusion — `offsetParent === null`, i.e. display:none on an
    // ANCESTOR — is deliberately not asserted here. jsdom has no layout engine
    // and reports a null offsetParent for every element on the page (memory
    // `jsdom-cannot-see-layout`), so the guard is capability-gated on
    // `checkVisibility` and is inert in this environment. A test for it would
    // pass without the code.
    screen.getByLabelText('Real').focus()
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }))
  })
})

describe('Escape belongs to a native picker first (ROSTER-FIX.6b-9)', () => {
  it('does not close the dialog on the Escape a <select> handles itself', () => {
    const onClose = vi.fn()
    render(
      <Modal open onClose={onClose} title="t">
        <select aria-label="Template"><option value="">Pick</option></select>
      </Modal>
    )
    const select = screen.getByLabelText('Template')
    select.focus()
    fireEvent.keyDown(select, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()

    // …but only the first one, so Escape can never become a dead key.
    fireEvent.keyDown(select, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('does the same for a native date input and not for a text input', () => {
    const onClose = vi.fn()
    render(
      <Modal open onClose={onClose} title="t">
        <input type="date" aria-label="From" />
        <input type="text" aria-label="Reason" />
      </Modal>
    )
    fireEvent.keyDown(screen.getByLabelText('From'), { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()

    // A plain text field has no Escape behaviour of its own, so the dialog
    // keeps it — taking it away would be a new way to trap the operator.
    fireEvent.keyDown(screen.getByLabelText('Reason'), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
