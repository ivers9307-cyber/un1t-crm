// @vitest-environment jsdom
//
// MAIL-READER.1 (05) — READING MODE.
//
// Richard chose this over the two lighter variants ("scroll only", "fold on
// demand"). The reader card is 78vh; with the composer open, the four bands of
// header above the correspondence are being paid for by an operator who has
// stopped reading them and started writing. So: focus the composer and the
// header folds to a single line — subject, who it is with, the nudge as a
// count, the one action worth keeping, and a caret back.
//
// THE RULE THE WHOLE FEATURE HANGS ON: nothing moves that the operator did not
// act on. Which is why every assertion below is about an EVENT, and why three
// of them are about the fold NOT happening:
//
//   • expanding the composer alone does not fold — clicking Reply and reading
//     on is not writing;
//   • a manual unfold STICKS. Without that, the caret is a no-op: unfolding
//     leaves focus nowhere near the textarea, and the operator's very next
//     click into it would fold it straight back, reading as a header that
//     refuses to stay open;
//   • it comes back on its own on the three exits — the composer collapsing to
//     the pill, the caret, and scrolling the thread to the top.
//
// The 46%/40% composer cap is layout, so it is pinned here only as the class
// recipe: jsdom has no layout engine and would happily pass a cap that
// resolves to nothing (a recorded trap — a green suite once shipped a toggle
// that did nothing at all).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'
import ConversationThread from './ConversationThread.jsx'

// ReplyBox is STUBBED for the integration block below, deliberately. What is
// under test there is ConversationThread's ownership of the mode — it holds
// `reading` and `manuallyUnfolded` precisely because the three exits are facts
// about three different children — and the real composer has no way to collapse
// itself back to the pill once expanded, so its `onCollapsedChange(true)` is
// only reachable through the prop. The real component's own half of the
// contract (the cap class, the textarea's focus report) is asserted against the
// UNMOCKED module in the last block, via vi.importActual.
const stub = vi.hoisted(() => ({ props: null }))
vi.mock('./ReplyBox', () => ({
  default: (props) => {
    stub.props = props
    return (
      <div data-testid="composer" data-reading={String(!!props.reading)}>
        <textarea aria-label="Stub composer" onFocus={() => props.onComposerFocus?.()} />
        <button type="button" onClick={() => props.onCollapsedChange?.(false)}>stub expand</button>
        <button type="button" onClick={() => props.onCollapsedChange?.(true)}>stub collapse</button>
      </div>
    )
  },
}))
vi.mock('@/components/mail/viewer-id', () => ({ resolveViewerId: vi.fn(async () => 'user-1') }))

beforeEach(() => {
  window.HTMLElement.prototype.scrollIntoView = vi.fn()
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
  stub.props = null
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  window.localStorage.clear()
})

// Fixtures in the shape ConversationThread.flat.test.jsx already uses.
const TICKET = {
  id: 'T-1',
  status: 'open',
  subject: 'Flogas bill for Hatch Street',
  requester_email: 'jordan.sample@example.test',
  requester_name: 'Jordan Sample',
  mailbox: { id: 'mb-1', label: 'Accounts', address: 'accounts@hatch.ie' },
}
const MESSAGE = {
  id: 'm1',
  direction: 'inbound',
  from_email: 'jordan.sample@example.test',
  to_emails: ['accounts@hatch.ie'],
  text_body: 'Our records show the August meter read is outstanding.',
  created_at: '2026-08-28T09:00:00Z',
}
const noop = () => {}

// The caller's slots, in the two shapes MailThread passes: three icon actions
// on the full header, exactly one on the folded line.
const CONTROLS = (
  <div>
    <button type="button" aria-label="Archive" title="Archive" />
    <button type="button" aria-label="Mark as spam" title="Mark as spam" />
    <button type="button" aria-label="Mark unread" title="Mark unread" />
  </div>
)
const COMPACT_CONTROLS = <button type="button" aria-label="Archive" title="Archive" />
const COMPACT_BANNER = <span role="status">1 other</span>

function renderThread(props = {}) {
  return render(
    <ConversationThread
      hasSelection
      conversation={TICKET}
      messages={[MESSAGE]}
      replyRecipients={{ to: [TICKET.requester_email], mode: 'reply', empty: false }}
      controls={CONTROLS}
      compactControls={COMPACT_CONTROLS}
      compactBanner={COMPACT_BANNER}
      onBack={noop}
      onSend={noop}
      {...props}
    />
  )
}

const heading = () => screen.queryByRole('heading', { name: TICKET.subject })
const caret = () => screen.queryByRole('button', { name: 'Show details' })
const focusComposer = () => fireEvent.focus(screen.getByLabelText('Stub composer'))
const threadList = () => document.querySelector('.min-h-0.flex-1.overflow-y-auto')

describe('ConversationThread — the header is whole until the operator writes', () => {
  it('renders the full header by default: heading, participants, no caret', () => {
    renderThread()
    expect(heading()).toBeTruthy()
    // EMAIL-PARTICIPANTS.8's line — the live audience, not just a name.
    expect(screen.getByText(/On this thread:/)).toBeTruthy()
    expect(caret()).toBeNull()
    expect(screen.getByRole('button', { name: 'Mark as spam' })).toBeTruthy()
  })

  it('does not fold when the composer merely expands', () => {
    renderThread()
    fireEvent.click(screen.getByText('stub expand'))
    expect(heading()).toBeTruthy()
    expect(caret()).toBeNull()
  })
})

describe('ConversationThread — focusing the composer folds the header', () => {
  it('replaces the header block with one line: subject, sender, caret, Archive only', () => {
    renderThread()
    focusComposer()

    // The heading is gone — the folded line is a status strip, not a heading
    // that appears and disappears as the operator types.
    expect(heading()).toBeNull()
    expect(screen.queryByText(/On this thread:/)).toBeNull()

    const folded = caret().closest('div')
    expect(folded.className).toContain('border-b')
    expect(folded.className).toContain('py-1.5')
    expect(folded.textContent).toContain(TICKET.subject)
    expect(folded.textContent).toContain('Jordan Sample')
    expect(folded.textContent).toContain(TICKET.requester_email)
    // The nudge, counted, still in the line.
    expect(folded.contains(screen.getByRole('status'))).toBe(true)

    // ONE action survives the fold.
    expect(screen.getByRole('button', { name: 'Archive' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Mark as spam' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Mark unread' })).toBeNull()
  })

  it('gives the caret the folded state and steals no focus', () => {
    renderThread()
    const textarea = screen.getByLabelText('Stub composer')
    textarea.focus()
    fireEvent.focus(textarea)
    expect(caret().getAttribute('aria-expanded')).toBe('false')
    // Folding must never pull the caret out from under a keystroke aimed at
    // the textarea.
    expect(document.activeElement).toBe(textarea)
  })
})

describe('ConversationThread — a manual unfold sticks', () => {
  it('unfolds on the caret and refuses to re-fold on the next focus', () => {
    renderThread()
    focusComposer()
    expect(heading()).toBeNull()

    fireEvent.click(caret())
    expect(heading()).toBeTruthy()
    expect(caret()).toBeNull()

    // The click that put focus back in the box must not undo the unfold.
    focusComposer()
    expect(heading()).toBeTruthy()
  })
})

describe('ConversationThread — the three exits', () => {
  it('unfolds when the composer collapses back to the pill, and resets the manual unfold', () => {
    renderThread()
    focusComposer()
    fireEvent.click(caret())          // manual unfold — sticky from here
    fireEvent.click(screen.getByText('stub collapse'))
    expect(heading()).toBeTruthy()

    // "Done writing" is the one event that clears the stickiness, so the next
    // time the operator settles in the header folds again.
    focusComposer()
    expect(heading()).toBeNull()
  })

  it('unfolds when the thread is scrolled back to the top', () => {
    renderThread()
    focusComposer()
    expect(heading()).toBeNull()

    fireEvent.scroll(threadList(), { target: { scrollTop: 0 } })
    expect(heading()).toBeTruthy()
  })

  it('stays folded on a scroll that is not at the top', () => {
    renderThread()
    focusComposer()
    const list = threadList()
    Object.defineProperty(list, 'scrollTop', { value: 120, configurable: true })
    fireEvent.scroll(list)
    expect(heading()).toBeNull()
  })
})

describe('ConversationThread — the composer is told', () => {
  it('passes `reading` down, and only while the header is folded', () => {
    renderThread()
    expect(stub.props.reading).toBe(false)
    focusComposer()
    expect(stub.props.reading).toBe(true)
    fireEvent.click(caret())
    expect(stub.props.reading).toBe(false)
  })
})

// The real component, unmocked: its half of the same contract.
describe('ReplyBox — the cap and the focus report', () => {
  async function renderRealBox(props = {}) {
    const { default: RealReplyBox } = await vi.importActual('./ReplyBox.jsx')
    return render(
      <RealReplyBox
        conversation={TICKET}
        replyRecipients={{ to: [TICKET.requester_email], mode: 'reply', empty: false }}
        onSend={() => ({ ok: true })}
        {...props}
      />
    )
  }

  it('widens the cap to 46% of the card while reading, 40% otherwise', async () => {
    await renderRealBox({ reading: true })
    expect(document.querySelector('form').className).toContain('max-h-[46%]')
    expect(document.querySelector('form').className).not.toContain('max-h-[40%]')
    cleanup()

    await renderRealBox({ reading: false })
    expect(document.querySelector('form').className).toContain('max-h-[40%]')
    expect(document.querySelector('form').className).not.toContain('max-h-[46%]')
  })

  it('reports a focus on the TEXTAREA, which is what settling in to write means', async () => {
    const onComposerFocus = vi.fn()
    await renderRealBox({ onComposerFocus })
    fireEvent.focus(document.querySelector('#conversation-composer'))
    expect(onComposerFocus).toHaveBeenCalled()
  })

  it('reports its collapsed shape, including the pill it starts as', async () => {
    const onCollapsedChange = vi.fn()
    await renderRealBox({ startCollapsed: true, onCollapsedChange })
    expect(onCollapsedChange).toHaveBeenCalledWith(true)

    onCollapsedChange.mockClear()
    fireEvent.click(screen.getByText('Reply ↵'))
    expect(onCollapsedChange).toHaveBeenCalledWith(false)
  })
})
