// EMAIL-CC.1 — the recipient editor's two load-bearing affordances.
//
// Node-environment static-markup test (the pattern this repo uses — no
// jsdom/testing-library). It cannot test typing, and does not try to: the
// interaction is ordinary chip-input behaviour. What it pins is the shape of
// the rendered form, which is where the two rules that matter are expressed:
//
//   • CC/BCC ARE HIDDEN UNTIL WANTED, and revealed for good once either holds
//     an address. A Bcc field permanently open on a support reply invites a
//     Bcc nobody needed; one that could re-hide a typed address would hide a
//     recipient.
//   • A THREAD PARTICIPANT HAS NO REMOVE BUTTON. The server enforces it (the
//     reply route always includes the derived set and has no wire format for
//     dropping one); this is the half an operator can see.

import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

import RecipientEditor, { EMPTY_RECIPIENTS } from './RecipientEditor.jsx'

const noop = () => {}

function render(props = {}) {
  return renderToStaticMarkup(
    <RecipientEditor
      idPrefix="t"
      value={EMPTY_RECIPIENTS}
      onChange={noop}
      {...props}
    />,
  )
}

describe('RecipientEditor — Cc/Bcc stay out of the way', () => {
  it('shows only To, behind a Cc/Bcc reveal, when nothing is copied', () => {
    const html = render()
    expect(html).toContain('Cc / Bcc')
    expect(html).not.toContain('id="t-cc"')
    expect(html).not.toContain('id="t-bcc"')
  })

  it('opens both fields when a Cc is already present', () => {
    const html = render({ value: { to: [], cc: ['colleague@example.com'], bcc: [] } })
    expect(html).toContain('id="t-cc"')
    expect(html).toContain('id="t-bcc"')
    // The reveal is gone — it could only ever hide a recipient from here.
    expect(html).not.toContain('Cc / Bcc')
  })

  it('opens both fields when a Bcc is already present', () => {
    const html = render({ value: { to: [], cc: [], bcc: ['boss@example.com'] } })
    expect(html).toContain('id="t-bcc"')
    expect(html).toContain('boss@example.com')
  })
})

describe('RecipientEditor — Bcc says what it is', () => {
  // The one thing a person must not have to remember at 5pm is which of two
  // adjacent boxes is the private one.
  it('labels Bcc as hidden from the other recipients, and Cc as visible', () => {
    const html = render({ value: { to: [], cc: ['a@example.com'], bcc: [] } })
    expect(html).toContain('Hidden from everyone else on this email.')
    expect(html).toContain('Everyone on this email can see the Cc list.')
  })
})

describe('RecipientEditor — thread participants cannot be removed', () => {
  it('renders a locked participant with NO remove control', () => {
    const html = render({
      lockedTo: ['member@example.com'],
      lockedHint: 'Everybody on this thread is included.',
    })
    expect(html).toContain('member@example.com')
    expect(html).not.toContain('Remove member@example.com')
    expect(html).toContain('Everybody on this thread is included.')
  })

  // …while an address the operator typed IS theirs to take back.
  it('renders an added recipient WITH a remove control', () => {
    const html = render({ value: { to: ['extra@example.com'], cc: [], bcc: [] } })
    expect(html).toContain('Remove extra@example.com')
  })

  it('renders both kinds side by side, distinguishable only by the remove control', () => {
    const html = render({
      lockedTo: ['member@example.com'],
      value: { to: ['extra@example.com'], cc: [], bcc: [] },
    })
    expect(html).toContain('Remove extra@example.com')
    expect(html).not.toContain('Remove member@example.com')
  })
})
