// @vitest-environment jsdom
//
// EMAIL-PARTICIPANTS.7 — the reply audience, on screen and subtractable.
//
// The route half of this programme derives the audience from the WHOLE thread
// and refuses a send that is empty or over the 25-recipient cap. None of that
// was visible: an operator could not see who a reply reached, and had no way to
// take anyone off it. These three tests pin the composer's half.
//
// REMOVE-ONLY, AND THAT IS THE PRODUCT DECISION (Richard). There is no
// free-form "add a recipient" box here — the audience stays derived, and the
// only edit is subtraction. So there is deliberately no test for adding one.
//
// jsdom + testing-library (the Modal.focus.test.jsx idiom) because two of the
// three are behaviours — a click that must reach a callback, and a submit that
// must not reach one — which static markup cannot see.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'
import TicketReplyBox from './TicketReplyBox.jsx'

beforeEach(() => {
  // Nothing in these tests wants the network. A never-resolving fetch is the
  // quiet stub the sibling composer tests use — the signature hint's own
  // preferences GET simply never settles, so the hint stays hidden
  // (cosmetic; SignatureHint.test.jsx is where it is exercised).
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
  // Every case here mounts ticket-1. Since the composer now hydrates a
  // per-ticket draft from localStorage on mount (see TicketReplyBox.draft
  // .test.jsx), a value typed in one test would otherwise leak into the next
  // test's fresh render of the "same" ticket — nothing to do with the
  // recipient behaviour these tests actually pin.
  window.localStorage.clear()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  window.localStorage.clear()
})

const TICKET = {
  id: 'ticket-1',
  subject: 'Membership freeze',
  requester_email: 'a@x.com',
  status: 'open',
}

/** The shape the detail route returns as `reply_recipients`. */
function audience(to) {
  return {
    to,
    mode: to.length > 1 ? 'reply_all' : 'reply',
    over_cap: to.length > 25,
    empty: to.length === 0,
  }
}

function renderBox(props = {}) {
  return render(
    <TicketReplyBox
      ticket={TICKET}
      replyRecipients={audience(['a@x.com'])}
      onSend={vi.fn()}
      onRemoveRecipient={vi.fn()}
      onRestoreRecipient={vi.fn()}
      {...props}
    />
  )
}

describe('TicketReplyBox — the reply audience', () => {
  it('shows every derived recipient as a chip', () => {
    const to = ['a@x.com', 'b@y.com', 'c@z.com']
    renderBox({ replyRecipients: audience(to) })

    // Every address, in the server's order, and none invented. The chips are
    // the only place an operator can see who the next reply reaches.
    const chips = screen.getAllByRole('button', { name: /^Remove / })
    expect(chips.map(b => b.getAttribute('aria-label'))).toEqual(to.map(a => `Remove ${a}`))

    // And the address is ON the chip, beside its ×, rather than only in the
    // button's accessible name.
    for (const address of to) {
      const chip = screen.getByRole('button', { name: `Remove ${address}` }).parentElement
      expect(chip.textContent).toContain(address)
    }
  })

  it("calls onRemoveRecipient with the chip's own address when its × is clicked", () => {
    const onRemoveRecipient = vi.fn()
    renderBox({ replyRecipients: audience(['a@x.com', 'b@y.com']), onRemoveRecipient })

    fireEvent.click(screen.getByRole('button', { name: /remove a@x\.com/i }))

    // Exactly the one clicked. A × that removed the wrong participant would be
    // invisible until the next reply reached the wrong people.
    expect(onRemoveRecipient).toHaveBeenCalledTimes(1)
    expect(onRemoveRecipient).toHaveBeenCalledWith('a@x.com')
  })

  it('blocks the send and explains when the thread is over the recipient cap', () => {
    const to = Array.from({ length: 26 }, (_, i) => `p${i}@x.com`)
    const onSend = vi.fn()
    const { container } = renderBox({
      ticket: { ...TICKET, requester_email: 'p0@x.com' },
      replyRecipients: audience(to),
      onSend,
    })

    fireEvent.change(screen.getByLabelText('Reply to the member'), {
      target: { value: 'Sorry for the delay.' },
    })

    // Disabled, not merely inert: a live-looking button that silently does
    // nothing is the worse half of this failure.
    const send = screen.getByRole('button', { name: 'Reply All (26 people)' })
    expect(send.disabled).toBe(true)
    fireEvent.click(send)

    // And the rule is stated at the send itself, so a submit that never went
    // through the button cannot get past it either.
    fireEvent.submit(container.querySelector('form'))

    // The route would 400 this. The composer must not spend a round trip
    // discovering that — and must never look as though the reply went.
    expect(onSend).not.toHaveBeenCalled()
    expect(screen.getByText(/26 recipients and the limit is 25/i)).toBeTruthy()
  })

  it('shows no chips and refuses to send once the audience has been emptied', () => {
    const onSend = vi.fn()
    // What the server answers after the last participant is removed: an empty
    // set, deliberately, NOT "we could not work out who" — and the requester
    // sitting in excluded_participants is how it got that way.
    const { container } = renderBox({
      ticket: { ...TICKET, excluded_participants: ['a@x.com'] },
      replyRecipients: audience([]),
      onSend,
    })

    // The requester fallback must not run here. It did, and put the person the
    // operator had just removed back on screen as a chip — and into the line
    // naming who the reply reaches — while the route refused the send.
    expect(screen.queryAllByRole('button', { name: /^Remove / })).toHaveLength(0)
    // It may appear as a REMOVED chip below, but never as somebody this reply
    // reaches, and the line that names them must not claim otherwise.
    expect(screen.queryByText(/Sends an email to/i)).toBeNull()

    // The reply route's own words, so the composer and its 400 agree.
    expect(screen.getByText(/no recipients left/i)).toBeTruthy()

    // And the thing that sentence tells them to do is on screen. Without it
    // the empty state is a one-way door: the copy says "restore one" and there
    // is nothing to restore with, so the ticket can never be replied to again.
    expect(screen.getByRole('button', { name: 'Restore a@x.com' })).toBeTruthy()

    fireEvent.change(screen.getByLabelText('Reply to the member'), {
      target: { value: 'Are you still there?' },
    })
    expect(screen.getByRole('button', { name: 'Reply' }).disabled).toBe(true)
    fireEvent.submit(container.querySelector('form'))
    expect(onSend).not.toHaveBeenCalled()
  })
})

describe('TicketReplyBox — the people taken off it', () => {
  it('shows removed participants as restorable, and not as recipients', () => {
    renderBox({
      ticket: { ...TICKET, excluded_participants: ['gone@x.com', 'also@y.com'] },
      replyRecipients: audience(['a@x.com']),
    })

    // Every removed address is on screen with a way back. Vanishing silently
    // is what made a removal impossible to see, let alone undo.
    for (const address of ['gone@x.com', 'also@y.com']) {
      expect(screen.getByRole('button', { name: `Restore ${address}` })).toBeTruthy()
    }

    // And they are NOT offered as recipients: a × beside a removed address
    // would say they were still on the reply.
    expect(screen.queryByRole('button', { name: 'Remove gone@x.com' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Remove a@x.com' })).toBeTruthy()

    // Never in note mode: a note reaches nobody, so "not on this reply" is not
    // a distinction it can draw.
    fireEvent.click(screen.getByRole('button', { name: 'Internal note' }))
    expect(screen.queryByRole('button', { name: /^Restore / })).toBeNull()
  })

  it('disables both chip actions while a participants write is in flight', () => {
    renderBox({
      ticket: { ...TICKET, excluded_participants: ['gone@x.com'] },
      replyRecipients: audience(['a@x.com']),
      participantSaving: true,
    })

    // The writes are serialised, so a second click during one is dropped. The
    // controls have to say that: this composer's own send button was fixed for
    // exactly this reason, and a live-looking × that does nothing is the same
    // defect one component deeper.
    expect(screen.getByRole('button', { name: 'Remove a@x.com' }).disabled).toBe(true)
    expect(screen.getByRole('button', { name: 'Restore gone@x.com' }).disabled).toBe(true)
  })

  it("calls onRestoreRecipient with the chip's own address", () => {
    const onRestoreRecipient = vi.fn()
    renderBox({
      ticket: { ...TICKET, excluded_participants: ['gone@x.com', 'also@y.com'] },
      replyRecipients: audience(['a@x.com']),
      onRestoreRecipient,
    })

    fireEvent.click(screen.getByRole('button', { name: /restore also@y\.com/i }))

    expect(onRestoreRecipient).toHaveBeenCalledTimes(1)
    expect(onRestoreRecipient).toHaveBeenCalledWith('also@y.com')
  })
})

describe('TicketReplyBox — the box names who it will reach', () => {
  it('placeholders the derived audience, not the requester', () => {
    // The 2026-08-12 ticket: opened by the rates office, now with Eleanor. The
    // placeholder read `Reply to ${ticket.requester_email}`, so the box an
    // operator types into named the wrong person — the same defect as the
    // header, one component along, and in the most prominent place of all.
    renderBox({
      ticket: { ...TICKET, requester_email: 'rates@council.ie' },
      replyRecipients: audience(['eleanor@council.ie']),
    })

    const box = screen.getByLabelText('Reply to the member')
    expect(box.placeholder).toBe('Reply to eleanor@council.ie…')
    expect(box.placeholder).not.toContain('rates@council.ie')
  })

  it('counts the rest rather than naming one of several', () => {
    renderBox({
      ticket: { ...TICKET, requester_email: 'rates@council.ie' },
      replyRecipients: audience(['eleanor@council.ie', 'rates@council.ie', 'clerk@council.ie']),
    })

    // Naming one person when three are on it is the mistake in miniature. The
    // first is the live counterparty and the rest are a count — the idiom the
    // send button ("Reply All (3 people)") already uses.
    expect(screen.getByLabelText('Reply to the member').placeholder)
      .toBe('Reply to eleanor@council.ie and 2 others…')
  })

  it('names nobody once the audience has been emptied', () => {
    renderBox({
      ticket: { ...TICKET, excluded_participants: ['a@x.com'] },
      replyRecipients: audience([]),
    })

    // It reads the same `lockedTo` the send does, so it inherits the rule that
    // an emptied audience does NOT fall back to the requester. Naming them
    // here would put the person the operator just removed back in front of
    // them, in the box, while the route refuses the send.
    expect(screen.getByLabelText('Reply to the member').placeholder).toBe('Reply…')
  })
})
