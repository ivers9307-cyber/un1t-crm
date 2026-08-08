// @vitest-environment jsdom
//
// TICKET-COMPOSE-DISCARD.1 — a typed email must not vanish on a stray Esc.
//
// The bug (2026-08-08 audit): the compose modal used the ui Modal's defaults,
// which close on Esc, backdrop click and the X — silently discarding a
// fully-typed email. The component's own header says "A FAILED SEND MUST NOT
// COST THEM THE DRAFT"; an accidental keypress was costing them the same
// draft. Dismissing a DIRTY compose now asks first (bare confirm(), the repo
// idiom — ExpensesManager.jsx). A pristine one still closes silently: asking
// "discard this email?" about an empty form is noise.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'
import TicketCompose from './TicketCompose.jsx'

const MAILBOX = { id: 'mb-1', label: 'Front desk', address: 'hello@example.com', is_default: true }
const noop = () => {}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function compose(onClose) {
  return <TicketCompose mailboxes={[MAILBOX]} onClose={onClose} onSent={noop} />
}

describe('TicketCompose — dismissing a dirty draft asks first', () => {
  it('closes a pristine compose on Esc without asking', () => {
    const confirmSpy = vi.fn()
    vi.stubGlobal('confirm', confirmSpy)
    const onClose = vi.fn()
    render(compose(onClose))

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(confirmSpy).not.toHaveBeenCalled()
  })

  it('keeps the draft when Esc is pressed and the operator declines', () => {
    vi.stubGlobal('confirm', vi.fn(() => false))
    const onClose = vi.fn()
    render(compose(onClose))

    fireEvent.change(screen.getByPlaceholderText('Write the email…'), {
      target: { value: 'Hi — following up on your enquiry about small group training.' },
    })
    fireEvent.keyDown(document, { key: 'Escape' })

    expect(onClose).not.toHaveBeenCalled()
    // The draft is still on screen, untouched.
    expect(screen.getByPlaceholderText('Write the email…').value).toContain('small group training')
  })

  it('discards when the operator confirms', () => {
    vi.stubGlobal('confirm', vi.fn(() => true))
    const onClose = vi.fn()
    render(compose(onClose))

    fireEvent.change(screen.getByPlaceholderText('What this is about'), {
      target: { value: 'Small group training' },
    })
    fireEvent.keyDown(document, { key: 'Escape' })

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('guards the Cancel button by the same rule', () => {
    const confirmSpy = vi.fn(() => false)
    vi.stubGlobal('confirm', confirmSpy)
    const onClose = vi.fn()
    render(compose(onClose))

    fireEvent.change(screen.getByPlaceholderText('What this is about'), {
      target: { value: 'Small group training' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(confirmSpy).toHaveBeenCalledTimes(1)
    expect(onClose).not.toHaveBeenCalled()
  })
})
