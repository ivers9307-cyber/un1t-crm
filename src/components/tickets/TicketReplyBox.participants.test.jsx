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
  // quiet stub the sibling composer tests use — the signature preview treats a
  // missing signature as cosmetic, and no other request is made on mount.
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
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
      // Supplied so the signature preview does not fetch — it is not what any
      // of this is about.
      signature=""
      onRemoveRecipient={vi.fn()}
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
    renderBox({
      ticket: { ...TICKET, requester_email: 'p0@x.com' },
      replyRecipients: audience(to),
      onSend,
    })

    fireEvent.change(screen.getByLabelText('Reply to the member'), {
      target: { value: 'Sorry for the delay.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Reply All (26 people)' }))

    // The route would 400 this. The composer must not spend a round trip
    // discovering that — and must never look as though the reply went.
    expect(onSend).not.toHaveBeenCalled()
    expect(screen.getByText(/26 recipients and the limit is 25/i)).toBeTruthy()
  })
})
