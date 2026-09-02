// @vitest-environment jsdom
//
// MAIL-TRIAL.B — the surface end to end, against a stubbed network.
//
// THREE THINGS ARE WORTH THIS MUCH MACHINERY:
//
// 1. 🔴 `e` MUST NOT ARCHIVE WHILE SOMEBODY IS TYPING. This surface's main
//    control is a composer, so a bare single-letter shortcut either files a
//    conversation away or types the letter e into a half-written reply. Get it
//    backwards and an operator loses a draft AND finds a member's mail
//    archived, with no visible cause. It is the most expensive bug this
//    surface could ship and the cheapest one to pin.
//
// 2. Archiving REMOVES THE ROW and moves on. Waiting for the 60s poll to clear
//    a conversation the operator has just dealt with is what turns a list back
//    into a queue — which is the thing the ticket surface already is.
//
// 3. The needs-reply filter asks the SERVER for needs_reply. A client-side
//    filter over the loaded page would silently disagree with the badge beside
//    it, and a badge that opens a list not matching it is a badge people learn
//    to ignore.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor, within, act } from '@testing-library/react'

// MAIL-DEEPLINK.1 — `?c=<id>`. `routerReplace`/`routerPush` are the spies
// every deep-link test reads; `currentSearchParams` is reassigned per test
// (default: empty) so a test can simulate landing on
// /communications/mail?c=<id> without a real Next router underneath it.
//
// L6 — `replace` ALSO updates `currentSearchParams` from the url it was
// given, mirroring what Next itself does (a replace changes what
// useSearchParams() returns on the next render). Without this, L6's
// "already correct — skip the replace" guard could never see a TRUE
// current value: it would always compare against the frozen value from
// mount, making every later replace look like a no-op regardless of what
// this surface actually asked for.
let routerReplace
let routerPush
let currentSearchParams
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    replace: (url, opts) => {
      const qIndex = String(url).indexOf('?')
      currentSearchParams = new URLSearchParams(qIndex === -1 ? '' : String(url).slice(qIndex + 1))
      routerReplace(url, opts)
    },
    push: (...args) => routerPush(...args),
  }),
  useSearchParams: () => currentSearchParams,
}))

import MailSurface from './MailSurface.jsx'

const LOC = 'a0000000-0000-0000-0000-000000000001'

const CONV_A = {
  id: 'conv-a',
  mailbox_id: 'mb-1',
  requester_email: 'ella@member.ie',
  requester_name: 'Ella Byrne',
  subject: 'Membership freeze',
  last_message_preview: 'Can I freeze from Monday?',
  last_message_direction: 'inbound',
  last_message_at: '2026-08-26T09:00:00Z',
  status: 'open',
  needs_reply: true,
  archived: false,
  unread: false,
  message_count: 2,
}
const CONV_B = {
  ...CONV_A,
  id: 'conv-b',
  requester_name: 'Fionn Doyle',
  requester_email: 'fionn@member.ie',
  subject: 'Class times',
  last_message_at: '2026-08-26T08:00:00Z',
}

const MAILBOX = { id: 'mb-1', label: 'Studio', address: 'hatchstreet@un1t.com', is_default: true, active: true }

// MAIL-DEEPLINK-SEC.1 — the mount-time `?c=` read is validated against the
// house uuid shape, so any test that seeds `currentSearchParams` with an id
// for the mount effect to pick up needs a REAL uuid-shaped one; the rest of
// this file's fixture ids (conv-a, conv-b, …) deliberately stay short and
// readable everywhere else (selection is always by explicit id, never
// parsed off a URL, outside these deep-link tests).
const DEEP_LINK_UUID = 'b0000000-0000-4000-8000-000000000001'
const OFF_LIST_UUID = 'c0000000-0000-4000-8000-000000000002'
const CONV_B_UUID = { ...CONV_B, id: 'd0000000-0000-4000-8000-000000000003', unread: true }

// Every request the surface makes, recorded, so a test can assert WHAT was
// asked for rather than only what came back. The stub also HONOURS the archive
// it is asked for — a stub that kept handing back the row it had just archived
// would hide the one behaviour this file exists to check.
let calls
let archivedIds
function stubNetwork({ conversations = [CONV_A, CONV_B], needsReplyCount = 1 } = {}) {
  calls = []
  archivedIds = new Set()
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    calls.push({ url: String(url), method: init?.method || 'GET', body: init?.body ? JSON.parse(init.body) : null })
    const u = String(url)
    if (u.startsWith('/api/email/mail?')) {
      const wantsNeedsReply = u.includes('view=needs_reply')
      const live = conversations.filter(c => !archivedIds.has(c.id))
      return json({
        success: true,
        data: {
          mailboxes: [MAILBOX],
          conversations: wantsNeedsReply ? live.filter(c => c.needs_reply) : live,
          next_before: null,
          needs_reply_count: needsReplyCount,
          counts_unavailable: false,
          counts_partial: false,
        },
      })
    }
    if (u.startsWith('/api/email/tickets/')) {
      const id = u.split('/')[4]
      const row = conversations.find(c => c.id === id) || CONV_A
      return json({
        success: true,
        data: {
          ticket: { ...row, mailbox: MAILBOX },
          messages: [{
            id: `m-${id}`, direction: 'inbound', is_internal_note: false,
            from_email: row.requester_email, text_body: `Message on ${row.subject}`,
            created_at: '2026-08-26T08:00:00Z',
          }],
          reply_recipients: { to: [row.requester_email], mode: 'reply' },
        },
      })
    }
    if (u.includes('/archive')) {
      const id = u.split('/')[4]
      if (init?.body && JSON.parse(init.body).archived) archivedIds.add(id)
      else archivedIds.delete(id)
      return json({
        success: true,
        data: {
          conversation: { ...(conversations.find(c => c.id === id) || CONV_A), status: 'closed', archived: true },
          writeback_notice: null,
        },
      })
    }
    if (u.includes('/seen')) return json({ success: true, data: { unread: 0, writeback_notice: null } })
    return json({ success: true, data: {} })
  }))
}

const json = (body) => ({ ok: true, status: 200, json: async () => body })

beforeEach(() => {
  window.HTMLElement.prototype.scrollIntoView = vi.fn()
  stubNetwork()
  routerReplace = vi.fn()
  routerPush = vi.fn()
  currentSearchParams = new URLSearchParams()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const renderSurface = () =>
  render(<MailSurface locationId={LOC} locationName="UN1T Hatch Street" userId="me-1" />)

// DEFLAKE (CI run 33270835641, 2026-08-29) — the surface's j/k/e handler is a
// WINDOW listener re-attached in a passive effect, closing over
// conversations/selectedId/composeOpen. A findBy*/waitFor resolves on the DOM
// COMMIT, which can land before that effect flush — so a keydown fired
// straight after an await could still hit the PREVIOUS closure: an empty list
// makes j a silent no-op (the flake — neighbourId([]) is null), and a stale
// composeOpen=false would let `e` archive behind an open modal. A real user
// cannot type inside a microsecond effect-flush window, so the component is
// fine; the test must flush pending effects before pressing, which is exactly
// what an empty async act() does. Every keydown that relies on state an
// earlier await established goes through this.
const flushEffects = () => act(async () => {})

const listCalls = () => calls.filter(c => c.url.startsWith('/api/email/mail?'))
// The filter strip is named, because "Needs reply" is also a chip on the rows
// below it — without the name they are two identical strings to anyone
// navigating by label, in a test and with a screen reader alike.
//
// MAIL-SURFACE.2 — the old `role="group"` pill row moved into the rail
// (`nav[aria-label="Mail folders"]`); this helper follows it there rather
// than asserting against a strip that no longer exists.
const views = () => screen.getByRole('navigation', { name: 'Mail folders' })
const postsTo = (fragment) => calls.filter(c => c.method === 'POST' && c.url.includes(fragment))

describe('MailSurface — the filter strip', () => {
  it('offers three views and no assignment views', async () => {
    renderSurface()
    await screen.findByText('Membership freeze')
    const strip = views()
    expect(within(strip).getByRole('button', { name: /^Inbox$/ })).toBeTruthy()
    expect(within(strip).getByRole('button', { name: /Needs reply/ })).toBeTruthy()
    expect(within(strip).getByRole('button', { name: /^Archived$/ })).toBeTruthy()
    expect(within(strip).queryByRole('button', { name: /Unassigned/ })).toBeNull()
    expect(within(strip).queryByRole('button', { name: /^Mine$/ })).toBeNull()
  })

  it('badges the needs-reply filter with the server’s count', async () => {
    stubNetwork({ needsReplyCount: 4 })
    renderSurface()
    await screen.findByText('Membership freeze')
    expect(within(views()).getByRole('button', { name: /Needs reply/ }).textContent).toContain('4')
  })

  it('asks the SERVER for needs_reply rather than filtering the loaded page', async () => {
    renderSurface()
    await screen.findByText('Membership freeze')
    fireEvent.click(within(views()).getByRole('button', { name: /Needs reply/ }))
    await waitFor(() => expect(listCalls().some(c => c.url.includes('view=needs_reply'))).toBe(true))
  })

  it('does not send the default view, so one list is one URL', async () => {
    renderSurface()
    await screen.findByText('Membership freeze')
    expect(listCalls()[0].url).toBe(`/api/email/mail?location_id=${LOC}`)
  })
})

describe('MailSurface — opening a conversation', () => {
  it('reads the thread through the ticket surface’s own detail route', async () => {
    // A second read path would be a second sanitiser decision, a second
    // attachment shape and a second reply-audience derivation.
    renderSurface()
    fireEvent.click(await screen.findByText('Membership freeze'))
    await screen.findByText('Message on Membership freeze')
    expect(calls.some(c => c.url === '/api/email/tickets/conv-a')).toBe(true)
  })

  it('marks an unread conversation read on open, and does not touch a read one', async () => {
    stubNetwork({ conversations: [{ ...CONV_A, unread: true }] })
    renderSurface()
    fireEvent.click(await screen.findByText('Membership freeze'))
    await waitFor(() => expect(postsTo('/seen')).toHaveLength(1))
    // `true` is the only value the route accepts — there is no honest
    // mark-unread on this surface, so there is no wire format for one.
    expect(postsTo('/seen')[0].body).toEqual({ seen: true })

    cleanup()
    stubNetwork({ conversations: [{ ...CONV_A, unread: false }] })
    renderSurface()
    fireEvent.click(await screen.findByText('Membership freeze'))
    await screen.findByText('Message on Membership freeze')
    expect(postsTo('/seen')).toHaveLength(0)
  })
})

describe('MailSurface — archiving clears the list', () => {
  it('removes the row and moves to the next conversation', async () => {
    renderSurface()
    fireEvent.click(await screen.findByText('Membership freeze'))
    await screen.findByText('Message on Membership freeze')

    fireEvent.click(screen.getByRole('button', { name: /^Archive$/ }))
    await waitFor(() => expect(screen.queryByText('Membership freeze')).toBeNull())
    // …and the operator is left on the next one rather than on nothing.
    await screen.findByText('Message on Class times')
  })

  it('posts the STATE being asked for, not a lifecycle value', async () => {
    renderSurface()
    fireEvent.click(await screen.findByText('Membership freeze'))
    await screen.findByText('Message on Membership freeze')
    fireEvent.click(screen.getByRole('button', { name: /^Archive$/ }))
    await waitFor(() => expect(postsTo('/archive')).toHaveLength(1))
    expect(postsTo('/archive')[0].body).toEqual({ archived: true })
    expect(postsTo('/archive')[0].url).toBe('/api/email/mail/conv-a/archive')
  })
})

describe('MailSurface — keyboard', () => {
  it('j moves to the next conversation and opens it', async () => {
    renderSurface()
    await screen.findByText('Membership freeze')
    await flushEffects()
    fireEvent.keyDown(document.body, { key: 'j' })
    await screen.findByText('Message on Membership freeze')
    await flushEffects()
    fireEvent.keyDown(document.body, { key: 'j' })
    await screen.findByText('Message on Class times')
  })

  it('k moves back, and does not wrap off the top', async () => {
    renderSurface()
    await screen.findByText('Membership freeze')
    await flushEffects()
    fireEvent.keyDown(document.body, { key: 'j' })
    await screen.findByText('Message on Membership freeze')
    // Already on the first conversation — k must do nothing rather than jump
    // to the oldest one with no visible cause.
    await flushEffects()
    fireEvent.keyDown(document.body, { key: 'k' })
    await screen.findByText('Message on Membership freeze')
  })

  it('e archives the open conversation', async () => {
    renderSurface()
    fireEvent.click(await screen.findByText('Membership freeze'))
    await screen.findByText('Message on Membership freeze')
    await flushEffects()
    fireEvent.keyDown(document.body, { key: 'e' })
    await waitFor(() => expect(postsTo('/archive')).toHaveLength(1))
  })

  // 🔴 The one that matters.
  it('NEVER archives while the operator is typing a reply', async () => {
    renderSurface()
    fireEvent.click(await screen.findByText('Membership freeze'))
    await screen.findByText('Message on Membership freeze')

    // MAIL-DOCK.1 — the dock opens the composer as the slim pill; typing
    // means expanding it first, which is exactly what an operator does.
    fireEvent.click(screen.getByRole('button', { name: 'Reply ↵' }))
    const composer = document.getElementById('ticket-composer')
    expect(composer).toBeTruthy()
    // Flushed so the listener provably holds the OPEN selection — otherwise a
    // stale closure with no selectedId makes this pass vacuously (e would
    // no-op for the wrong reason and the typing guard would go untested).
    await flushEffects()
    fireEvent.keyDown(composer, { key: 'e' })
    fireEvent.keyDown(composer, { key: 'j' })
    fireEvent.keyDown(composer, { key: 'u' })

    // Nothing was archived, and the operator was not navigated away from the
    // conversation they are answering.
    expect(postsTo('/archive')).toHaveLength(0)
    expect(screen.getByText('Message on Membership freeze')).toBeTruthy()
  })

  // 🔴 The one that ACTUALLY got away: the reply box is a <textarea>, so the
  // test above passed while the compose modal — whose first keystroke lands on
  // a focused dialog DIV, not a field — was wide open.
  it('NEVER archives while the compose modal is open', async () => {
    renderSurface()
    fireEvent.click(await screen.findByText('Membership freeze'))
    await screen.findByText('Message on Membership freeze')

    fireEvent.click(screen.getByRole('button', { name: /New email/i }))
    const dialog = await screen.findByRole('dialog')

    // Typing a recipient that starts with 'e' — the exact keystroke that used
    // to archive the conversation behind the modal and move the real message.
    // Flushed so the listener provably knows composeOpen=true: a stale
    // closure here (fresh selectedId, composeOpen still false) would archive
    // behind the modal — the very bug this test pins — as a flake.
    await flushEffects()
    fireEvent.keyDown(dialog, { key: 'e' })
    fireEvent.keyDown(dialog, { key: 'j' })
    fireEvent.keyDown(dialog, { key: 'k' })
    fireEvent.keyDown(dialog, { key: 'u' })

    expect(postsTo('/archive')).toHaveLength(0)
    // And the modal is still there — 'u' did not collapse the surface under it.
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  // The half the DOM check cannot cover: focus is not always inside the dialog.
  // Clicking the backdrop, or a browser restoring focus to <body>, leaves the
  // modal open with keydowns targeting the page — where isTypingTarget is
  // correctly false. Only the component's own modal state knows better.
  it('NEVER archives while a modal is open, even when focus is on the page', async () => {
    renderSurface()
    fireEvent.click(await screen.findByText('Membership freeze'))
    await screen.findByText('Message on Membership freeze')

    fireEvent.click(screen.getByRole('button', { name: /New email/i }))
    await screen.findByRole('dialog')

    // Same flush reasoning as the dialog-focused variant above.
    await flushEffects()
    fireEvent.keyDown(document.body, { key: 'e' })
    fireEvent.keyDown(document.body, { key: 'u' })

    expect(postsTo('/archive')).toHaveLength(0)
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('ignores autorepeat, so holding e does not walk the list archiving', async () => {
    renderSurface()
    fireEvent.click(await screen.findByText('Membership freeze'))
    await screen.findByText('Message on Membership freeze')

    await flushEffects()
    fireEvent.keyDown(document.body, { key: 'e' })
    fireEvent.keyDown(document.body, { key: 'e', repeat: true })
    fireEvent.keyDown(document.body, { key: 'e', repeat: true })

    await waitFor(() => expect(postsTo('/archive')).toHaveLength(1))
  })

  it('marks a read conversation unread, both halves, through the seen route', async () => {
    stubNetwork({ conversations: [{ ...CONV_A, unread: false }, CONV_B] })
    const realFetch = globalThis.fetch
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      const u = String(url)
      if (u.includes('/seen')) {
        calls.push({ url: u, method: 'POST', body: JSON.parse(init.body) })
        return json({ success: true, data: { id: CONV_A.id, unread: 1, changed: 1, writeback_notice: null } })
      }
      return realFetch(url, init)
    }))

    renderSurface()
    fireEvent.click(await screen.findByText('Membership freeze'))
    await screen.findByText('Message on Membership freeze')

    fireEvent.click(screen.getByRole('button', { name: 'Mark unread' }))

    // The route is asked for the UNREAD direction — the half that only works
    // because markUnseen() clears the flag in the real mailbox too.
    await waitFor(() => expect(postsTo('/seen').length).toBeGreaterThan(0))
    expect(postsTo('/seen').some(c => c.body.seen === false)).toBe(true)
  })

  it('leaves modified keystrokes alone, so nothing shadows a browser shortcut', async () => {
    renderSurface()
    fireEvent.click(await screen.findByText('Membership freeze'))
    await screen.findByText('Message on Membership freeze')
    fireEvent.keyDown(document.body, { key: 'e', metaKey: true })
    expect(postsTo('/archive')).toHaveLength(0)
  })
})

// MAIL-DOCK.1 — the docked reader. jsdom has no layout engine, so mode is
// asserted through `data-reader-mode` and the classes that produce each shape
// (the same structural stand-in the rail-below-md test uses), while the
// BEHAVIOUR — Esc ladder, persistence, min restore, retargeting — is real.
describe('MailSurface — the dock', () => {
  const dock = () => document.querySelector('[data-reader-mode]')
  const openFirst = async () => {
    renderSurface()
    fireEvent.click(await screen.findByText('Membership freeze'))
    await screen.findByText('Message on Membership freeze')
    await flushEffects()
  }

  beforeEach(() => window.localStorage.clear())
  afterEach(() => window.localStorage.clear())

  it('nothing selected: a full-width list, no card, no "Select a conversation" pane', async () => {
    renderSurface()
    await screen.findByText('Membership freeze')
    expect(dock()).toBeNull()
    expect(screen.queryByText('Select a conversation')).toBeNull()
  })

  it('selecting a conversation opens the card in dock mode, wearing its title and controls', async () => {
    await openFirst()
    expect(dock().getAttribute('data-reader-mode')).toBe('dock')
    // The dark bar names the conversation; the subject is also the list row
    // and the thread heading, hence at least 3.
    expect(screen.getAllByText('Membership freeze').length).toBeGreaterThanOrEqual(3)
    expect(screen.getByRole('button', { name: 'Minimise the conversation' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Expand to full screen' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Close the conversation' })).toBeTruthy()
  })

  it('chips Needs reply on the bar only while the conversation needs one', async () => {
    await openFirst()
    // CONV_A needs a reply — the bar carries the chip beside the thread's own.
    expect(screen.getAllByText('Needs reply').length).toBeGreaterThanOrEqual(2)
  })

  it('✕ closes: selection cleared, ?c= dropped, the card unmounts', async () => {
    await openFirst()
    fireEvent.click(screen.getByRole('button', { name: 'Close the conversation' }))
    expect(dock()).toBeNull()
    expect(screen.queryByText('Message on Membership freeze')).toBeNull()
    expect(routerReplace).toHaveBeenLastCalledWith('/communications/mail', { scroll: false })
  })

  it('⤢ expands to full and PERSISTS the choice; ⤡ restores to dock and persists that', async () => {
    await openFirst()
    fireEvent.click(screen.getByRole('button', { name: 'Expand to full screen' }))
    expect(dock().getAttribute('data-reader-mode')).toBe('full')
    expect(window.localStorage.getItem('un1t.mail.reader-mode')).toBe('full')
    fireEvent.click(screen.getByRole('button', { name: 'Restore to docked size' }))
    expect(dock().getAttribute('data-reader-mode')).toBe('dock')
    expect(window.localStorage.getItem('un1t.mail.reader-mode')).toBe('dock')
  })

  it('a stored full-screen preference opens the NEXT conversation full-screen', async () => {
    window.localStorage.setItem('un1t.mail.reader-mode', 'full')
    await openFirst()
    expect(dock().getAttribute('data-reader-mode')).toBe('full')
  })

  it('a garbage stored mode fails safe to dock', async () => {
    window.localStorage.setItem('un1t.mail.reader-mode', 'sideways')
    await openFirst()
    expect(dock().getAttribute('data-reader-mode')).toBe('dock')
  })

  it('Esc steps full down to dock WITHOUT overwriting the stored preference, then closes', async () => {
    window.localStorage.setItem('un1t.mail.reader-mode', 'full')
    await openFirst()
    expect(dock().getAttribute('data-reader-mode')).toBe('full')
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(dock().getAttribute('data-reader-mode')).toBe('dock')
    // Esc is a dismissal, not a preference — full-screen next time too.
    expect(window.localStorage.getItem('un1t.mail.reader-mode')).toBe('full')
    await flushEffects()
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(dock()).toBeNull()
  })

  it('Esc does NOT fire while the operator is typing', async () => {
    await openFirst()
    fireEvent.click(screen.getByRole('button', { name: 'Reply ↵' }))
    const composer = document.getElementById('ticket-composer')
    await flushEffects()
    fireEvent.keyDown(composer, { key: 'Escape' })
    // Still open, still reading the same conversation.
    expect(dock()).toBeTruthy()
    expect(screen.getByText('Message on Membership freeze')).toBeTruthy()
  })

  it('Esc does NOT close the card while a modal owns the keyboard', async () => {
    await openFirst()
    fireEvent.click(screen.getByRole('button', { name: /New email/i }))
    await screen.findByRole('dialog')
    await flushEffects()
    fireEvent.keyDown(document.body, { key: 'Escape' })
    // The modal's own Esc handling may close the MODAL; the conversation
    // underneath must survive it.
    expect(dock()).toBeTruthy()
    expect(screen.getByText('Message on Membership freeze')).toBeTruthy()
  })

  it('─ minimises to the bar: thread hidden (not unmounted), min NEVER stored; the bar restores', async () => {
    await openFirst()
    fireEvent.click(screen.getByRole('button', { name: 'Minimise the conversation' }))
    expect(dock().getAttribute('data-reader-mode')).toBe('min')
    // Hidden at md+ by class, still MOUNTED — polls keep running.
    const body = dock().lastElementChild
    expect(body.className).toMatch(/(?:^|\s)md:hidden(?:\s|$)/)
    expect(screen.getByText('Message on Membership freeze')).toBeTruthy()
    // The transient state never reaches disk.
    expect(window.localStorage.getItem('un1t.mail.reader-mode')).toBeNull()
    // ─ again restores to the mode it came from.
    fireEvent.click(screen.getByRole('button', { name: 'Restore the conversation' }))
    expect(dock().getAttribute('data-reader-mode')).toBe('dock')
  })

  it('a card minimised from FULL restores to full', async () => {
    await openFirst()
    fireEvent.click(screen.getByRole('button', { name: 'Expand to full screen' }))
    fireEvent.click(screen.getByRole('button', { name: 'Minimise the conversation' }))
    expect(dock().getAttribute('data-reader-mode')).toBe('min')
    fireEvent.click(screen.getByRole('button', { name: 'Restore the conversation' }))
    expect(dock().getAttribute('data-reader-mode')).toBe('full')
  })

  it('Esc closes a minimised card outright', async () => {
    await openFirst()
    fireEvent.click(screen.getByRole('button', { name: 'Minimise the conversation' }))
    await flushEffects()
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(dock()).toBeNull()
  })

  it('closing from min does not leak min into the next open — it reopens as a real card', async () => {
    await openFirst()
    fireEvent.click(screen.getByRole('button', { name: 'Minimise the conversation' }))
    fireEvent.click(screen.getByRole('button', { name: 'Close the conversation' }))
    expect(dock()).toBeNull()
    fireEvent.click(screen.getByText('Class times'))
    await screen.findByText('Message on Class times')
    expect(dock().getAttribute('data-reader-mode')).toBe('dock')
  })

  it('j/k retarget the open card to the next conversation without closing or changing mode', async () => {
    window.localStorage.setItem('un1t.mail.reader-mode', 'full')
    await openFirst()
    expect(dock().getAttribute('data-reader-mode')).toBe('full')
    fireEvent.keyDown(document.body, { key: 'j' })
    await screen.findByText('Message on Class times')
    expect(dock().getAttribute('data-reader-mode')).toBe('full')
  })

  it('j while minimised retargets the bar without popping it open', async () => {
    await openFirst()
    fireEvent.click(screen.getByRole('button', { name: 'Minimise the conversation' }))
    await flushEffects()
    fireEvent.keyDown(document.body, { key: 'j' })
    await screen.findByText('Message on Class times')
    expect(dock().getAttribute('data-reader-mode')).toBe('min')
  })

  it('a mouse CLICK on a row restores a minimised card — a click means "open this"', async () => {
    // Audit A2 — j/k retarget the contracted bar (pinned above); a click is
    // a different intent, and retitling an invisible bar reads as broken.
    await openFirst()
    fireEvent.click(screen.getByRole('button', { name: 'Minimise the conversation' }))
    await flushEffects()
    fireEvent.click(screen.getAllByText('Class times')[0]) // the other row
    await flushEffects()
    expect(dock().getAttribute('data-reader-mode')).toBe('dock')
  })
})

describe('MailSurface — a mailbox half that did not land', () => {
  it('shows the notice beside a SUCCESSFUL archive rather than as a failure', async () => {
    stubNetwork()
    const realFetch = globalThis.fetch
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      if (String(url).includes('/archive')) {
        calls.push({ url: String(url), method: 'POST', body: JSON.parse(init.body) })
        return json({
          success: true,
          data: {
            conversation: { ...CONV_A, status: 'closed', archived: true },
            writeback_notice: 'The mail server refused this login.',
          },
        })
      }
      return realFetch(url, init)
    }))

    renderSurface()
    fireEvent.click(await screen.findByText('Membership freeze'))
    await screen.findByText('Message on Membership freeze')
    fireEvent.click(screen.getByRole('button', { name: /^Archive$/ }))
    // The archive stands — rolling it back would cost the operator what they
    // just did in order to report that half of it did not happen.
    await screen.findByText('The mail server refused this login.')
  })

  // 🔴 THE NOTICE MUST SURVIVE THE MOVE IT CAUSED. Archiving in the inbox view
  // removes the row and selects the successor; selecting an UNREAD successor
  // marks it read; and that mark-read used to clear the notice a few hundred
  // milliseconds later. Nothing converges archive state, so this sentence is
  // the only signal that will ever exist — and on an inbox (where unread
  // successors are the ordinary case) it was guaranteed to be erased.
  //
  // The fixtures above are all `unread: false`, which is exactly why the test
  // above could pass while this failed.
  it('KEEPS the notice when archiving moves to an unread successor', async () => {
    stubNetwork({ conversations: [CONV_A, { ...CONV_B, unread: true }] })
    const realFetch = globalThis.fetch
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      const u = String(url)
      if (u.includes('/archive')) {
        calls.push({ url: u, method: 'POST', body: JSON.parse(init.body) })
        return json({
          success: true,
          data: {
            conversation: { ...CONV_A, status: 'closed', archived: true },
            writeback_notice: 'Could not reach the mail server, so the change was not made in the mailbox.',
          },
        })
      }
      // The successor's mark-read succeeds and carries NO notice of its own —
      // the ordinary case, and the one that used to wipe the sentence.
      if (u.includes('/seen')) {
        calls.push({ url: u, method: 'POST', body: JSON.parse(init.body) })
        return json({ success: true, data: { conversation: { ...CONV_B, unread: false }, writeback_notice: null } })
      }
      return realFetch(url, init)
    }))

    renderSurface()
    fireEvent.click(await screen.findByText('Membership freeze'))
    await screen.findByText('Message on Membership freeze')
    fireEvent.click(screen.getByRole('button', { name: /^Archive$/ }))

    // The move happened…
    await screen.findByText('Message on Class times')
    // …the successor really was marked read (so the erasing path DID run)…
    await waitFor(() => expect(postsTo('/seen').length).toBeGreaterThan(0))
    // …and the sentence is still on screen afterwards.
    await waitFor(() => expect(
      screen.getByText('Could not reach the mail server, so the change was not made in the mailbox.'),
    ).toBeTruthy())
  })
})

// MAIL-SURFACE.2 — the rail, the search box and the density toggle.
describe('MailSurface — rail, search and density', () => {
  it('renders the rail instead of the old tab strip', async () => {
    renderSurface()
    await screen.findByText('Membership freeze')
    expect(screen.getByRole('navigation', { name: /Mail folders/i })).toBeTruthy()
    expect(screen.queryByRole('tablist', { name: /Mail accounts/i })).toBeNull()
  })

  // Fake timers only go on AFTER the initial load has settled (real timers),
  // and always come back off — `screen.findByText`'s polling relies on real
  // timers, so switching before the first render has resolved hangs every
  // test in the file behind it, not just this one.
  describe('debounce', () => {
    afterEach(() => { vi.useRealTimers() })

    it('sends the typed query to the list route, debounced', async () => {
      renderSurface()
      await screen.findByText('Membership freeze')
      calls.length = 0
      vi.useFakeTimers()

      const box = screen.getByRole('searchbox', { name: /Search mail/i })
      fireEvent.change(box, { target: { value: 'freeze' } })
      // Nothing yet — a request per keystroke is a request per keystroke.
      expect(calls.filter(c => c.url.includes('q=freeze'))).toHaveLength(0)

      await act(async () => { await vi.advanceTimersByTimeAsync(400) })
      expect(calls.some(c => c.url.includes('q=freeze'))).toBe(true)
    })

    it('does not send q at all when the box is cleared', async () => {
      renderSurface()
      await screen.findByText('Membership freeze')
      const box = screen.getByRole('searchbox', { name: /Search mail/i })
      vi.useFakeTimers()

      fireEvent.change(box, { target: { value: 'freeze' } })
      await act(async () => { await vi.advanceTimersByTimeAsync(400) })
      calls.length = 0

      fireEvent.change(box, { target: { value: '' } })
      await act(async () => { await vi.advanceTimersByTimeAsync(400) })
      expect(calls.every(c => !c.url.includes('q='))).toBe(true)
    })
  })

  it('starts comfortable (the approved two-line row) and remembers a switch to compact', async () => {
    renderSurface()
    await screen.findByText('Membership freeze')

    expect(screen.getByRole('button', { name: /^Comfortable$/i }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: /^Compact$/i }))
    expect(window.localStorage.getItem('un1t.mail.density')).toBe('compact')
  })

  // The search box is a typing target, so the shortcut guard has to cover it —
  // typing "e" into search must not archive the open conversation.
  it('NEVER archives while the operator is typing in the search box', async () => {
    renderSurface()
    fireEvent.click(await screen.findByText('Membership freeze'))
    await screen.findByText('Message on Membership freeze')

    const box = screen.getByRole('searchbox', { name: /Search mail/i })
    fireEvent.keyDown(box, { key: 'e' })

    expect(postsTo('/archive')).toHaveLength(0)
  })
})

// Types into the search box and lets the debounce settle. Written once so
// every test below shares the exact choreography the debounce block above
// already validates (fake timers only after the first real render, always
// back off before any findBy/waitFor that needs them).
async function searchFor(value) {
  const box = screen.getByRole('searchbox', { name: /Search mail/i })
  vi.useFakeTimers()
  fireEvent.change(box, { target: { value } })
  await act(async () => { await vi.advanceTimersByTimeAsync(400) })
  vi.useRealTimers()
  return box
}

// Defect 1 — "Older conversations" must carry the query, and the response's
// search_partial must update state, or page 2 of a search is unfiltered mail
// rendered as search hits with no way to reach the real matches beyond it.
describe('MailSurface — paging a search', () => {
  it('carries q into "Older conversations", and updates search_partial from that response', async () => {
    const seen = []
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const u = String(url)
      seen.push(u)
      if (u.startsWith('/api/email/mail?')) {
        if (u.includes('before=')) {
          // Page 2 only returns the real match when q travelled with it —
          // exactly the request the route needs to find matches beyond page 1.
          if (!u.includes('q=freeze')) {
            return json({
              success: true,
              data: {
                mailboxes: [MAILBOX], conversations: [], next_before: null,
                needs_reply_count: 0, counts_unavailable: false, counts_partial: false,
                search_partial: false,
              },
            })
          }
          return json({
            success: true,
            data: {
              mailboxes: [MAILBOX],
              conversations: [{ ...CONV_B, id: 'conv-c', subject: 'Older freeze match' }],
              next_before: null,
              needs_reply_count: 0,
              counts_unavailable: false,
              counts_partial: false,
              // Page 2's own scan was truncated — distinct from page 1's flag.
              search_partial: true,
            },
          })
        }
        return json({
          success: true,
          data: {
            mailboxes: [MAILBOX], conversations: [CONV_A], next_before: 'cursor-1',
            needs_reply_count: 0, counts_unavailable: false, counts_partial: false,
            search_partial: false,
          },
        })
      }
      if (u.startsWith('/api/email/tickets/')) {
        return json({ success: true, data: { ticket: { ...CONV_A, mailbox: MAILBOX }, messages: [], reply_recipients: null } })
      }
      return json({ success: true, data: {} })
    }))

    renderSurface()
    await screen.findByText('Membership freeze')
    await searchFor('freeze')
    await screen.findByText('Membership freeze')

    fireEvent.click(screen.getByRole('button', { name: /Older conversations/i }))
    await screen.findByText('Older freeze match')

    const pagedCall = seen.find(u => u.includes('before='))
    expect(pagedCall).toContain('q=freeze')

    // search_partial from THIS page reached the screen — loadMore is not a
    // dead end for the flag the way it used to be.
    await screen.findByText(/scanned only part of the mailbox/i)
  })
})

// Defect 2 — clicking a rail view mid-search must actually change what is
// shown, not relabel the rail and close the pane over identical rows.
describe('MailSurface — rail views during a search', () => {
  it('clears the search on a view click, rather than refetching the same rows', async () => {
    renderSurface()
    await screen.findByText('Membership freeze')
    const box = await searchFor('freeze')
    expect(box.value).toBe('freeze')

    calls.length = 0
    fireEvent.click(within(views()).getByRole('button', { name: /Needs reply/ }))

    await waitFor(() => expect(listCalls().some(c => c.url.includes('view=needs_reply'))).toBe(true))
    // The request for the new view carries no leftover query…
    expect(listCalls().every(c => !c.url.includes('q='))).toBe(true)
    // …and the box on screen agrees: the click did what it looks like it did.
    expect(box.value).toBe('')
  })
})

// Defect 3 — an archived row that still matches an active search must stay
// in the list, updated in place, not be removed and then silently return.
describe('MailSurface — archiving during a search', () => {
  it('keeps the row in place, rather than removing it and jumping the selection', async () => {
    let archivedId = null
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const u = String(url)
      if (u.startsWith('/api/email/mail?')) {
        const isSearch = u.includes('q=freeze')
        // Outside a search, an archived row drops out of the (default inbox)
        // scope — inside one, the route ignores view and it is still a match.
        const rows = [CONV_A, CONV_B]
          .filter(c => isSearch || c.id !== archivedId)
          .map(c => (c.id === archivedId ? { ...c, archived: true, status: 'closed' } : c))
        return json({
          success: true,
          data: {
            mailboxes: [MAILBOX], conversations: rows, next_before: null,
            needs_reply_count: 0, counts_unavailable: false, counts_partial: false,
            search_partial: false,
          },
        })
      }
      if (u.startsWith('/api/email/tickets/')) {
        const id = u.split('/')[4]
        const row = [CONV_A, CONV_B].find(c => c.id === id) || CONV_A
        return json({
          success: true,
          data: {
            ticket: { ...row, mailbox: MAILBOX },
            messages: [{
              id: `m-${id}`, direction: 'inbound', is_internal_note: false,
              from_email: row.requester_email, text_body: `Message on ${row.subject}`,
              created_at: '2026-08-26T08:00:00Z',
            }],
            reply_recipients: { to: [row.requester_email], mode: 'reply' },
          },
        })
      }
      if (u.includes('/archive')) {
        const id = u.split('/')[4]
        archivedId = id
        return json({ success: true, data: { conversation: { id, archived: true, status: 'closed' }, writeback_notice: null } })
      }
      if (u.includes('/seen')) return json({ success: true, data: { unread: 0, writeback_notice: null } })
      return json({ success: true, data: {} })
    }))

    renderSurface()
    await screen.findByText('Membership freeze')
    await searchFor('freeze')

    fireEvent.click(await screen.findByText('Membership freeze'))
    await screen.findByText('Message on Membership freeze')

    fireEvent.click(screen.getByRole('button', { name: /^Archive$/ }))

    // The row survives IN THE LIST — a search hit, archived or not — as well
    // as in the thread heading and the dock's title bar (MAIL-DOCK.1 added
    // the third): three instances of the subject on screen, not two. The old
    // behaviour would drop the list row for a moment and then bounce it back
    // once the quiet refetch below landed.
    await waitFor(() => expect(screen.getAllByText('Membership freeze')).toHaveLength(3))
    // …and the operator is left reading the same conversation, not bounced
    // off it onto a successor.
    expect(screen.getByText('Message on Membership freeze')).toBeTruthy()
  })
})

// Defect 4 — below `md`, the rail must not consume width the shell cannot
// afford. jsdom has NO layout engine, so pixel overflow cannot be measured
// here; this asserts the CLASS/structure that produces the responsive
// behaviour instead — a structural stand-in, not a claim about pixels.
describe('MailSurface — the rail below md', () => {
  it('wraps the rail in hidden/md:flex, so it drops out of the layout below md', async () => {
    renderSurface()
    await screen.findByText('Membership freeze')
    const rail = screen.getByRole('navigation', { name: 'Mail folders' })
    const wrapper = rail.parentElement
    expect(wrapper.className).toMatch(/(?:^|\s)hidden(?:\s|$)/)
    expect(wrapper.className).toMatch(/(?:^|\s)md:flex(?:\s|$)/)
  })
})

// MAIL-DEEPLINK.1 — `?c=<id>` on /communications/mail. The Today dashboard's
// mail lane names a specific conversation ("Sarah — needs reply"); until this,
// its href was a bare `/communications/mail` and the operator landed at the
// top of the list, not on the conversation named.
describe('MailSurface — deep link (?c=)', () => {
  it('writes ?c=<id> via router.replace — never push — when a conversation is selected', async () => {
    renderSurface()
    fireEvent.click(await screen.findByText('Membership freeze'))
    await screen.findByText('Message on Membership freeze')

    expect(routerReplace).toHaveBeenCalledWith('/communications/mail?c=conv-a', { scroll: false })
    expect(routerPush).not.toHaveBeenCalled()
  })

  it('j/k walking the list keeps REPLACING as it moves — no history spam', async () => {
    renderSurface()
    await screen.findByText('Membership freeze')
    // MAILKEY-DEFLAKE.1's rule, applied here too (this test predates it and
    // flaked in CI run 33656349165 the same way): the j/k handler is a
    // window listener re-attached in a passive effect, and findBy resolves
    // on the DOM commit — a keydown fired straight after the await can hit
    // the mount closure and silently no-op. Flush effects first.
    await flushEffects()
    fireEvent.keyDown(document.body, { key: 'j' })
    await screen.findByText('Message on Membership freeze')
    await flushEffects()
    fireEvent.keyDown(document.body, { key: 'j' })
    await screen.findByText('Message on Class times')

    expect(routerReplace).toHaveBeenCalledWith('/communications/mail?c=conv-a', { scroll: false })
    expect(routerReplace).toHaveBeenCalledWith('/communications/mail?c=conv-b', { scroll: false })
    expect(routerPush).not.toHaveBeenCalled()
  })

  it('u clears the param', async () => {
    renderSurface()
    fireEvent.click(await screen.findByText('Membership freeze'))
    await screen.findByText('Message on Membership freeze')
    routerReplace.mockClear()

    fireEvent.keyDown(document.body, { key: 'u' })

    expect(routerReplace).toHaveBeenCalledWith('/communications/mail', { scroll: false })
  })

  // 'u' with nothing selected already short-circuits before clearSelection is
  // even called (the existing `if (!selectedId) return` guard in the keydown
  // handler) — so the case worth pinning is a view/mailbox SWITCH, which
  // calls clearSelection() UNCONDITIONALLY regardless of whether anything is
  // selected.
  it('L6 — does not replace the URL when switching view/mailbox and there is nothing to clear', async () => {
    renderSurface()
    await screen.findByText('Membership freeze')
    routerReplace.mockClear()

    fireEvent.click(within(views()).getByRole('button', { name: /Needs reply/ }))
    await waitFor(() => expect(listCalls().some(c => c.url.includes('view=needs_reply'))).toBe(true))

    expect(routerReplace).not.toHaveBeenCalled()
  })

  // Switching mailbox/view already calls clearSelection() for reasons
  // unrelated to the URL (a genuinely fresh context) — reusing it here means
  // the param drops FOR FREE, and the two states (a selection, and the id in
  // the address bar) can never independently drift apart.
  it('switching view clears the selection, and so clears the param — the same coherent rule as u', async () => {
    renderSurface()
    fireEvent.click(await screen.findByText('Membership freeze'))
    await screen.findByText('Message on Membership freeze')
    routerReplace.mockClear()

    fireEvent.click(within(views()).getByRole('button', { name: /Needs reply/ }))

    expect(routerReplace).toHaveBeenCalledWith('/communications/mail', { scroll: false })
  })

  it('reads ?c= on mount and loads that conversation BY ID, even when it is not on page 1 of the list', async () => {
    currentSearchParams = new URLSearchParams(`c=${DEEP_LINK_UUID}`)
    // The list response never returns this id at all — it is not on any page
    // of the current view (e.g. it is old, or archived, or simply outside the
    // default sort). loadThread fetches by id unconditionally, so the pane
    // must still resolve without it.
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const u = String(url)
      if (u.startsWith('/api/email/mail?')) {
        return json({
          success: true,
          data: {
            mailboxes: [MAILBOX], conversations: [CONV_A], next_before: null,
            needs_reply_count: 0, counts_unavailable: false, counts_partial: false,
          },
        })
      }
      if (u === `/api/email/tickets/${DEEP_LINK_UUID}`) {
        return json({
          success: true,
          data: {
            ticket: { id: DEEP_LINK_UUID, subject: 'Off-page match', requester_email: 'z@member.ie', mailbox: MAILBOX },
            messages: [{
              id: 'm-z', direction: 'inbound', is_internal_note: false,
              from_email: 'z@member.ie', text_body: 'Message on off-page match',
              created_at: '2026-08-26T08:00:00Z',
            }],
            reply_recipients: { to: ['z@member.ie'], mode: 'reply' },
          },
        })
      }
      return json({ success: true, data: {} })
    }))

    renderSurface()
    await screen.findByText('Message on off-page match')
  })

  it('ignores a non-uuid ?c= outright, same as if it were absent (MAIL-DEEPLINK-SEC.1)', async () => {
    // Every id this surface deals in is a uuid; anything else has no honest
    // interpretation and must not be handed to loadThread/markRead —
    // `?c=..%2F..%2Ffoo` decodes to exactly this shape.
    currentSearchParams = new URLSearchParams('c=../../foo')
    renderSurface()
    await screen.findByText('Membership freeze')
    expect(calls.some(c => c.url.startsWith('/api/email/tickets/'))).toBe(false)
  })

  it('never lets ?c reach the list-fetch URL — buildMailUrl has no idea it exists', async () => {
    currentSearchParams = new URLSearchParams(`c=${OFF_LIST_UUID}`)
    renderSurface()
    // The deep link selects this id (thread pane header) even though it is
    // not in the stubbed list at all — the fallback ticket-detail response
    // below still names it "Membership freeze".
    await screen.findByText('Message on Membership freeze')
    expect(listCalls().every(c => !c.url.includes('c='))).toBe(true)
    expect(listCalls().every(c => !c.url.includes(OFF_LIST_UUID))).toBe(true)
  })

  // Reconciliation: the synthesized `{ id }` selection the mount effect seeds
  // carries none of the list row's own fields (unread, archived, …) —
  // loadThread's ticket-detail response doesn't carry them either (confirmed
  // by reading src/app/api/email/tickets/[id]/route.js). Once the list DOES
  // contain the row, an unread one must be marked read exactly as a click
  // would — an operator landing here from a link should not still see it bold.
  it('reconciles a deep-linked, unread row once the list contains it — marking it read like a click would', async () => {
    currentSearchParams = new URLSearchParams(`c=${CONV_B_UUID.id}`)
    stubNetwork({ conversations: [CONV_A, CONV_B_UUID] })

    renderSurface()
    await screen.findByText('Message on Class times')
    await waitFor(() => expect(postsTo('/seen').length).toBeGreaterThan(0))
    expect(postsTo('/seen')[0].url).toBe(`/api/email/mail/${CONV_B_UUID.id}/seen`)
    expect(postsTo('/seen')[0].body).toEqual({ seen: true })
  })

  // CONTRACTS finding 1+2(a) — this is the bug the fix actually closes: an
  // off-page conversation (never in ANY list payload) used to be read and
  // answered but never marked read at all, because the old code only marked
  // read when the list happened to contain the row.
  it('marks an off-page (never-listed) deep-linked conversation read once its thread loads — not dependent on list membership', async () => {
    currentSearchParams = new URLSearchParams(`c=${DEEP_LINK_UUID}`)
    const seenCalls = []
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      const u = String(url)
      if (u.startsWith('/api/email/mail?')) {
        // The list NEVER contains this id, on any page, ever.
        return json({
          success: true,
          data: {
            mailboxes: [MAILBOX], conversations: [CONV_A], next_before: null,
            needs_reply_count: 0, counts_unavailable: false, counts_partial: false,
          },
        })
      }
      if (u === `/api/email/tickets/${DEEP_LINK_UUID}`) {
        return json({
          success: true,
          data: {
            ticket: { id: DEEP_LINK_UUID, subject: 'Off-page', requester_email: 'z@member.ie', mailbox: MAILBOX },
            messages: [{
              id: 'm-z', direction: 'inbound', is_internal_note: false,
              from_email: 'z@member.ie', text_body: 'Message on off-page',
              created_at: '2026-08-26T08:00:00Z',
            }],
            reply_recipients: { to: ['z@member.ie'], mode: 'reply' },
          },
        })
      }
      if (u.includes('/seen')) {
        seenCalls.push({ url: u, body: JSON.parse(init.body) })
        return json({ success: true, data: { unread: 0, writeback_notice: null } })
      }
      return json({ success: true, data: {} })
    }))

    renderSurface()
    await screen.findByText('Message on off-page')
    await waitFor(() => expect(seenCalls.length).toBeGreaterThan(0))
    expect(seenCalls[0].url).toBe(`/api/email/mail/${DEEP_LINK_UUID}/seen`)
    expect(seenCalls[0].body).toEqual({ seen: true })
    // The toggle itself renders coherently afterwards — the ticket-detail
    // payload carries no `unread` flag, so without this fix the pane could
    // show "Mark unread" for a conversation that was never actually marked.
    await screen.findByRole('button', { name: 'Mark unread' })
  })

  // CONTRACTS finding 1+2(b) — the sharper bug: the OLD reconciliation ref
  // stayed armed forever, so a match arriving much later (a poll surfacing
  // new mail on the ORIGINAL deep-linked id) fired against whatever the
  // operator had since selected. Proven here by driving the exact sequence:
  // mount with an off-page id, let the first list settle (disarms the
  // reconciliation ref), select something else, THEN let a later poll
  // return a list that finally contains the original id — nothing must be
  // marked read and nothing must be repainted onto the new selection.
  it('does not repaint or mark-read the ORIGINAL deep-linked id once the operator has moved on to something else', async () => {
    currentSearchParams = new URLSearchParams(`c=${DEEP_LINK_UUID}`)
    const seenCalls = []
    // This test installs its OWN fetch stub (not the shared stubNetwork()),
    // so it keeps its own request log too — the shared `calls`/`listCalls()`
    // helpers only see requests made through the default stub.
    const listUrlLog = []
    let includeDeepLinkedRow = false
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      const u = String(url)
      if (u.startsWith('/api/email/mail?')) {
        listUrlLog.push(u)
        const rows = includeDeepLinkedRow
          ? [CONV_A, CONV_B, { id: DEEP_LINK_UUID, requester_name: 'Zara', subject: 'Off-page', last_message_at: '2026-08-26T10:00:00Z', unread: true }]
          : [CONV_A, CONV_B]
        return json({
          success: true,
          data: { mailboxes: [MAILBOX], conversations: rows, next_before: null, needs_reply_count: 0, counts_unavailable: false, counts_partial: false },
        })
      }
      if (u === `/api/email/tickets/${DEEP_LINK_UUID}`) {
        return json({ success: true, data: { ticket: { id: DEEP_LINK_UUID, subject: 'Off-page', mailbox: MAILBOX }, messages: [], reply_recipients: null } })
      }
      if (u.startsWith('/api/email/tickets/')) {
        const id = u.split('/')[4]
        const row = [CONV_A, CONV_B].find(c => c.id === id) || CONV_A
        return json({
          success: true,
          data: {
            ticket: { ...row, mailbox: MAILBOX },
            messages: [{ id: `m-${id}`, direction: 'inbound', is_internal_note: false, from_email: row.requester_email, text_body: `Message on ${row.subject}`, created_at: '2026-08-26T08:00:00Z' }],
            reply_recipients: { to: [row.requester_email], mode: 'reply' },
          },
        })
      }
      if (u.includes('/seen')) {
        seenCalls.push({ url: u, body: JSON.parse(init.body) })
        return json({ success: true, data: { unread: 0, writeback_notice: null } })
      }
      return json({ success: true, data: {} })
    }))

    renderSurface()
    // The deep-linked thread loads (and IS marked read — the loadThread-
    // success path, proven separately above); the first list settles WITHOUT
    // the row, which disarms the reconciliation ref for good.
    await waitFor(() => expect(seenCalls.length).toBe(1))
    seenCalls.length = 0

    // The operator moves on to a completely different conversation.
    fireEvent.click(await screen.findByText('Class times'))
    await screen.findByText('Message on Class times')

    // NOW a later poll (focus, in this test) returns a list that finally
    // contains the original deep-linked id. `window.addEventListener` is
    // what the poll effect uses (not React's synthetic events), so this
    // dispatches directly rather than through fireEvent.
    const listCallsBefore = listUrlLog.length
    includeDeepLinkedRow = true
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    await waitFor(() => expect(listUrlLog.length).toBeGreaterThan(listCallsBefore))
    // Give any (incorrect) reconciliation a moment it would need to run.
    await new Promise(r => setTimeout(r, 20))

    // Nothing was marked read on the reappeared id, and the pane still shows
    // the conversation the operator actually selected.
    expect(seenCalls).toHaveLength(0)
    expect(screen.getByText('Message on Class times')).toBeTruthy()
  })

  // A narrower race than the one above: here the deep-linked row genuinely
  // IS on the first list page (so the "disarm on first settle, regardless
  // of match" rule alone would happily reconcile it) — but the operator
  // presses `u` BEFORE that first, slow list response ever resolves. `u`
  // clears the selection — and disarms the ref — synchronously; the list
  // settling afterwards must not repaint a pane that no longer has this
  // conversation open. Structurally, every `setSelectedId` call in this file
  // lives in exactly three places — the mount effect (which ARMS the ref),
  // and selectConversation/clearSelection (which both disarm it) — so this
  // also demonstrates why the reconciliation effect's OWN `selectedId !== id`
  // check never gets to be the ONLY thing standing between a match and a
  // wrong repaint in this codebase: by the time selectedId genuinely differs
  // from the armed id, one of those two disarms has already run.
  it('u pressed before the FIRST (slow) list response resolves leaves nothing to reconcile once it does', async () => {
    currentSearchParams = new URLSearchParams(`c=${DEEP_LINK_UUID}`)
    let resolveList
    const pendingList = new Promise((res) => { resolveList = res })
    // A local log, not the shared `calls`/`postsTo` helpers — this test
    // installs its own fetch stub (not stubNetwork()), so those helpers
    // would only see requests made through the DEFAULT stub from beforeEach.
    const seenUrls = []
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const u = String(url)
      if (u.startsWith('/api/email/mail?')) {
        await pendingList // the list is SLOW — resolves only when told to
        return json({
          success: true,
          data: {
            // The deep-linked row genuinely IS on this (first) page.
            mailboxes: [MAILBOX],
            conversations: [CONV_A, CONV_B, { id: DEEP_LINK_UUID, requester_name: 'Zara', subject: 'Off-page', last_message_at: '2026-08-26T10:00:00Z', unread: true }],
            next_before: null, needs_reply_count: 0, counts_unavailable: false, counts_partial: false,
          },
        })
      }
      if (u === `/api/email/tickets/${DEEP_LINK_UUID}`) {
        return json({
          success: true,
          data: {
            ticket: { id: DEEP_LINK_UUID, subject: 'Off-page', mailbox: MAILBOX },
            messages: [{ id: 'm-z', direction: 'inbound', is_internal_note: false, from_email: 'z@x.com', text_body: 'Message on off-page', created_at: '2026-08-26T08:00:00Z' }],
            reply_recipients: null,
          },
        })
      }
      if (u.includes('/seen')) {
        seenUrls.push(u)
        return json({ success: true, data: { unread: 0, writeback_notice: null } })
      }
      return json({ success: true, data: {} })
    }))

    renderSurface()
    // The deep-linked thread itself loads fine (it does not wait on the
    // list at all) — but the list request is still hanging.
    await screen.findByText('Message on off-page')
    // …and it IS marked read (loadThread's own success path) — proven
    // separately above; this test cares about what happens AFTER, so let
    // that settle before pressing u.
    await waitFor(() => expect(seenUrls.length).toBe(1))
    seenUrls.length = 0

    // The operator backs out before the list ever answers.
    fireEvent.keyDown(document.body, { key: 'u' })
    await waitFor(() => expect(screen.queryByText('Message on off-page')).toBeNull())

    // NOW the slow list resolves, with the deep-linked row genuinely on it.
    resolveList()
    await waitFor(() => expect(screen.getByText('Off-page')).toBeTruthy()) // the list row itself

    // No selection was repainted back onto the pane, and nothing was posted
    // to /seen for it again — a match arriving after the operator has
    // already backed out must not resurrect the selection.
    expect(screen.queryByText('Message on off-page')).toBeNull()
    expect(seenUrls).toHaveLength(0)
  })
})

// TASK 2 — RAPID SINGLE ARCHIVES MUST NOT VANISH. archive()/markReadAction()
// used to bail out on `actionSaving`: hover-archive five rows click-click-
// click, and only the click whose POST happens to resolve first (usually the
// first one) does anything — the other four are silently dropped, with no
// visible cause. A client-side FIFO queue is the fix that keeps the single
// verb honest without building the multi-select toolbar the product review
// deliberately did NOT ask for.
describe('MailSurface — the archive queue', () => {
  const rowArchiveButtons = () =>
    screen.getAllByRole('button', { name: /^Archive .+'s conversation$/ })

  // CONTRACTS finding M3 — the SAME row, twice, rapidly. `e` computes its
  // target from `!isArchived(row)`, read off list state that has not moved
  // yet (the archive write is a multi-second, sequential IMAP call), so both
  // keystrokes used to compute the SAME `true` and the queue faithfully
  // archived it twice — where the second `e` plainly meant "put it back".
  it('two rapid e presses on the SAME conversation archive then UN-archive — a real undo, not a double archive', async () => {
    let resolveA
    const pendingA = new Promise((res) => { resolveA = res })
    const archivePosts = []
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      const u = String(url)
      if (u.startsWith('/api/email/mail?')) {
        return json({
          success: true,
          data: { mailboxes: [MAILBOX], conversations: [CONV_A, CONV_B], next_before: null, needs_reply_count: 0, counts_unavailable: false, counts_partial: false },
        })
      }
      if (u.startsWith('/api/email/tickets/')) {
        const id = u.split('/')[4]
        const row = [CONV_A, CONV_B].find(c => c.id === id) || CONV_A
        return json({
          success: true,
          data: {
            ticket: { ...row, mailbox: MAILBOX },
            messages: [{ id: `m-${id}`, direction: 'inbound', is_internal_note: false, from_email: row.requester_email, text_body: `Message on ${row.subject}`, created_at: '2026-08-26T08:00:00Z' }],
            reply_recipients: { to: [row.requester_email], mode: 'reply' },
          },
        })
      }
      if (u.includes('/archive')) {
        const id = u.split('/')[4]
        const body = JSON.parse(init.body)
        archivePosts.push({ id, archived: body.archived })
        // conv-a's FIRST write hangs — the second `e` fires while list state
        // still says "not archived", which is exactly the stale read this
        // fix must not trust.
        if (id === 'conv-a' && archivePosts.length === 1) await pendingA
        return json({ success: true, data: { conversation: { id, status: body.archived ? 'closed' : 'open', archived: body.archived }, writeback_notice: null } })
      }
      if (u.includes('/seen')) return json({ success: true, data: { unread: 0, writeback_notice: null } })
      return json({ success: true, data: {} })
    }))

    renderSurface()
    fireEvent.click(await screen.findByText('Membership freeze'))
    await screen.findByText('Message on Membership freeze')

    // Two rapid `e` presses — the first's write is still in flight (hung on
    // pendingA) when the second is queued.
    fireEvent.keyDown(document.body, { key: 'e' })
    fireEvent.keyDown(document.body, { key: 'e' })
    resolveA()

    await waitFor(() => expect(archivePosts).toHaveLength(2))
    expect(archivePosts[0]).toEqual({ id: 'conv-a', archived: true })
    // The SECOND post — not a repeat of the first — carries the UNDO.
    expect(archivePosts[1]).toEqual({ id: 'conv-a', archived: false })
  })

  it('queues a second archive on a different row, firing it only after the first COMPLETES', async () => {
    let resolveA
    const pendingA = new Promise((res) => { resolveA = res })
    const archiveUrls = []
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const u = String(url)
      if (u.startsWith('/api/email/mail?')) {
        return json({
          success: true,
          data: { mailboxes: [MAILBOX], conversations: [CONV_A, CONV_B], next_before: null, needs_reply_count: 0, counts_unavailable: false, counts_partial: false },
        })
      }
      if (u.startsWith('/api/email/tickets/')) {
        const id = u.split('/')[4]
        const row = [CONV_A, CONV_B].find(c => c.id === id) || CONV_A
        return json({ success: true, data: { ticket: { ...row, mailbox: MAILBOX }, messages: [], reply_recipients: null } })
      }
      if (u.includes('/archive')) {
        archiveUrls.push(u)
        const id = u.split('/')[4]
        if (id === 'conv-a') await pendingA
        return json({ success: true, data: { conversation: { id, status: 'closed', archived: true }, writeback_notice: null } })
      }
      return json({ success: true, data: {} })
    }))

    renderSurface()
    await screen.findByText('Membership freeze')

    const buttons = rowArchiveButtons()
    fireEvent.click(buttons[0]) // conv-a — hangs on pendingA
    fireEvent.click(buttons[1]) // conv-b — must be QUEUED, not dropped

    // conv-a's write fired; conv-b's has NOT — it is waiting its turn, not
    // silently discarded the way it would have been before this fix.
    await waitFor(() => expect(archiveUrls).toHaveLength(1))
    expect(archiveUrls[0]).toBe('/api/email/mail/conv-a/archive')

    resolveA()
    await waitFor(() => expect(archiveUrls).toHaveLength(2))
    expect(archiveUrls[1]).toBe('/api/email/mail/conv-b/archive')
  })

  it('a failed queued action surfaces its own error but does not drop the next queued action', async () => {
    // Tracks archived rows itself (mirroring stubNetwork's `archivedIds`) so
    // the quiet loadList(true) refresh a SUCCESSFUL archive triggers reflects
    // it — otherwise that refresh would silently re-add the row this test is
    // asserting left the list, for a reason that has nothing to do with the
    // queue.
    const archivedIds = new Set()
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const u = String(url)
      if (u.startsWith('/api/email/mail?')) {
        const live = [CONV_A, CONV_B].filter(c => !archivedIds.has(c.id))
        return json({
          success: true,
          data: { mailboxes: [MAILBOX], conversations: live, next_before: null, needs_reply_count: 0, counts_unavailable: false, counts_partial: false },
        })
      }
      if (u.startsWith('/api/email/tickets/')) {
        const id = u.split('/')[4]
        const row = [CONV_A, CONV_B].find(c => c.id === id) || CONV_A
        return json({
          success: true,
          data: {
            ticket: { ...row, mailbox: MAILBOX },
            messages: [{ id: `m-${id}`, direction: 'inbound', is_internal_note: false, from_email: row.requester_email, text_body: `Message on ${row.subject}`, created_at: '2026-08-26T08:00:00Z' }],
            reply_recipients: { to: [row.requester_email], mode: 'reply' },
          },
        })
      }
      if (u.includes('/archive')) {
        const id = u.split('/')[4]
        if (id === 'conv-a') return json({ success: false, error: 'Could not archive that' })
        archivedIds.add(id)
        return json({ success: true, data: { conversation: { id, status: 'closed', archived: true }, writeback_notice: null } })
      }
      if (u.includes('/seen')) return json({ success: true, data: { unread: 0, writeback_notice: null } })
      return json({ success: true, data: {} })
    }))

    renderSurface()
    fireEvent.click(await screen.findByText('Membership freeze'))
    await screen.findByText('Message on Membership freeze')

    // conv-a via the open thread pane — will fail.
    fireEvent.click(screen.getByRole('button', { name: /^Archive$/ }))
    // conv-b via its row action — queued behind conv-a, must still run.
    const buttons = rowArchiveButtons()
    fireEvent.click(buttons[1])

    await screen.findByText('Could not archive that')
    // conv-b's row is gone — its archive, queued behind a FAILED one, still
    // went through.
    await waitFor(() => expect(screen.queryByText('Class times')).toBeNull())
    // conv-a genuinely failed — nothing was rolled back (rolling it back
    // would cost the operator having to redo it), and it is still on screen.
    expect(screen.getByText('Message on Membership freeze')).toBeTruthy()
  })

  it('stops draining after unmount — it does not fire the next queued write into a dead component', async () => {
    let resolveA
    const pendingA = new Promise((res) => { resolveA = res })
    const archiveUrls = []
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const u = String(url)
      if (u.startsWith('/api/email/mail?')) {
        return json({
          success: true,
          data: { mailboxes: [MAILBOX], conversations: [CONV_A, CONV_B], next_before: null, needs_reply_count: 0, counts_unavailable: false, counts_partial: false },
        })
      }
      if (u.startsWith('/api/email/tickets/')) {
        return json({ success: true, data: { ticket: { ...CONV_A, mailbox: MAILBOX }, messages: [], reply_recipients: null } })
      }
      if (u.includes('/archive')) {
        archiveUrls.push(u)
        const id = u.split('/')[4]
        if (id === 'conv-a') await pendingA
        return json({ success: true, data: { conversation: { id, status: 'closed', archived: true }, writeback_notice: null } })
      }
      return json({ success: true, data: {} })
    }))

    const { unmount } = render(<MailSurface locationId={LOC} locationName="UN1T Hatch Street" userId="me-1" />)
    await screen.findByText('Membership freeze')
    const buttons = rowArchiveButtons()
    fireEvent.click(buttons[0]) // conv-a — pending
    fireEvent.click(buttons[1]) // conv-b — queued behind it
    await waitFor(() => expect(archiveUrls).toEqual(['/api/email/mail/conv-a/archive']))

    expect(() => unmount()).not.toThrow()
    resolveA()
    // Let every pending microtask from conv-a's resolution settle.
    await act(async () => {
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    })

    // conv-b's write never fired — the queue stopped when the component did,
    // rather than continuing to shift and process a row nobody can see the
    // result of any more.
    expect(archiveUrls).toEqual(['/api/email/mail/conv-a/archive'])
  })
})

// ═══════════════════════════════════════════════════════════════════════
// MAIL-ALLLOC.1 — the multi-location surface: tiles, All mode, scope.
// ═══════════════════════════════════════════════════════════════════════

const LOC_A = 'a0000000-0000-4000-8000-00000000000a'
const LOC_B = 'b0000000-0000-4000-8000-00000000000b'
const ELIGIBLE = [
  { id: LOC_A, name: 'Hatch Street' },
  { id: LOC_B, name: 'Stillorgan' },
]

const rowFor = (id, locationId, over = {}) => ({
  ...CONV_A,
  id,
  location_id: locationId,
  requester_name: `Person ${id}`,
  subject: `Subject ${id}`,
  ...over,
})

// The multi-location stub: a digest endpoint plus per-location scoped lists.
// `state` is mutable so a test can archive a row or blip a studio and let the
// next (re)fetch answer differently — the same honesty as stubNetwork above.
function stubMultiNetwork(state) {
  calls = []
  const digestPayload = () => {
    const locations = state.locations
      .filter(l => !state.droppedFromDigest?.includes(l.id))
      .map(l => (state.unavailable?.includes(l.id)
        ? {
            location_id: l.id, name: l.name, unavailable: true,
            needs_reply_count: null, view_total: null, conversations: [],
          }
        : {
            location_id: l.id, name: l.name, unavailable: false,
            needs_reply_count: l.needsReply ?? 0,
            view_total: l.viewTotal ?? (l.rows || []).length,
            conversations: (l.rows || []).filter(r => !state.archived?.has(r.id)),
          }))
    const partial = locations.some(l => l.unavailable)
    return {
      locations,
      needs_reply_total: partial ? null : locations.reduce((s, l) => s + (l.needs_reply_count || 0), 0),
      partial,
    }
  }
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    calls.push({ url: String(url), method: init?.method || 'GET', body: init?.body ? JSON.parse(init.body) : null })
    const u = String(url)
    if (u.startsWith('/api/email/mail/digest')) {
      return json({ success: true, data: digestPayload() })
    }
    if (u.startsWith('/api/email/mail?')) {
      const params = new URLSearchParams(u.split('?')[1])
      const locId = params.get('location_id')
      const loc = state.locations.find(l => l.id === locId)
      if (params.get('q') && state.failSearchFor?.includes(locId)) {
        return json({ success: false, error: 'search blew up' })
      }
      return json({
        success: true,
        data: {
          mailboxes: loc?.mailboxes || [],
          conversations: (loc?.rows || []).filter(r => !state.archived?.has(r.id)),
          next_before: null,
          needs_reply_count: loc?.needsReply ?? 0,
          counts_unavailable: false,
          counts_partial: false,
        },
      })
    }
    if (u.includes('/archive')) {
      const id = u.split('/')[4]
      state.archived = state.archived || new Set()
      if (init?.body && JSON.parse(init.body).archived) state.archived.add(id)
      else state.archived.delete(id)
      const all = state.locations.flatMap(l => l.rows || [])
      return json({
        success: true,
        data: {
          conversation: { ...(all.find(r => r.id === id) || {}), status: 'closed', archived: true },
          writeback_notice: null,
        },
      })
    }
    if (u.includes('/seen')) return json({ success: true, data: { unread: 0, writeback_notice: null } })
    if (u.startsWith('/api/email/tickets/')) {
      const id = u.split('/')[4]
      const all = state.locations.flatMap(l => l.rows || [])
      const row = all.find(r => r.id === id) || CONV_A
      return json({
        success: true,
        data: {
          ticket: { ...row },
          messages: [],
          reply_recipients: { to: [row.requester_email], mode: 'reply' },
        },
      })
    }
    return json({ success: true, data: {} })
  }))
  return state
}

const defaultMultiState = () => ({
  locations: [
    {
      id: LOC_A, name: 'Hatch Street', needsReply: 3, viewTotal: 38,
      rows: [rowFor('ha-1', LOC_A), rowFor('ha-2', LOC_A)],
      mailboxes: [{ id: 'mb-a', label: null, address: 'accounts@hatch.ie', is_default: true, active: true }],
    },
    {
      id: LOC_B, name: 'Stillorgan', needsReply: 1, viewTotal: 1,
      rows: [rowFor('st-1', LOC_B)],
      mailboxes: [{ id: 'mb-b', label: 'Info', address: 'info@still.ie', is_default: true, active: true }],
    },
  ],
})

const renderMulti = (props = {}) =>
  render(
    <MailSurface
      locationId={LOC_A}
      locationName="Hatch Street"
      userId="me-1"
      locations={ELIGIBLE}
      {...props}
    />
  )

const digestCalls = () => calls.filter(c => c.url.startsWith('/api/email/mail/digest'))
const scopedListCalls = (locId) =>
  calls.filter(c => c.url.startsWith('/api/email/mail?') && c.url.includes(`location_id=${locId}`))

describe('MailSurface — multi-location (MAIL-ALLLOC.1)', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('a single-location caller never sees a tile and never fetches the digest', async () => {
    renderSurface() // the file-wide single-location render
    await screen.findByText('Membership freeze')
    expect(screen.queryByText('All locations')).toBeNull()
    expect(digestCalls()).toHaveLength(0)
  })

  it('defaults to All: fetches the digest, renders tiles and grouped sticky sections', async () => {
    stubMultiNetwork(defaultMultiState())
    renderMulti()
    await screen.findByText('Subject ha-1')
    // Tiles: All + both studios, needs-reply chips from the digest.
    const allTile = screen.getByRole('button', { name: /All locations/ })
    expect(allTile.getAttribute('aria-pressed')).toBe('true')
    expect(allTile.textContent).toContain('4') // 3 + 1 summed
    expect(screen.getByRole('button', { name: /Hatch Street.*3/s })).toBeTruthy()
    // Sections group the rows under studio headers.
    const hatch = screen.getByRole('region', { name: 'Hatch Street' })
    expect(within(hatch).getByText('Subject ha-1')).toBeTruthy()
    const still = screen.getByRole('region', { name: 'Stillorgan' })
    expect(within(still).getByText('Subject st-1')).toBeTruthy()
    // No scoped list fetch happened — All mode IS the digest.
    expect(scopedListCalls(LOC_A)).toHaveLength(0)
  })

  it('the View-all row scopes into the studio, persists the choice, and loads its full list', async () => {
    stubMultiNetwork(defaultMultiState())
    renderMulti()
    await screen.findByText('Subject ha-1')
    fireEvent.click(screen.getByRole('button', { name: 'View all 38 in Hatch Street →' }))
    await waitFor(() => expect(scopedListCalls(LOC_A).length).toBeGreaterThan(0))
    expect(window.localStorage.getItem('un1t.mail.scope.me-1')).toBe(LOC_A)
    // Scoped: sections gone, account filter idiom back (single studio label).
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Stillorgan' })).toBeNull())
  })

  it('a persisted studio scope is honoured on mount — scoped list, no All flash', async () => {
    window.localStorage.setItem('un1t.mail.scope.me-1', LOC_B)
    stubMultiNetwork(defaultMultiState())
    renderMulti()
    await screen.findByText('Subject st-1')
    expect(screen.queryByText('Subject ha-1')).toBeNull()
    expect(scopedListCalls(LOC_B).length).toBeGreaterThan(0)
    // The Stillorgan tile is pressed, and tiles still render (scope switcher).
    expect(screen.getByRole('button', { name: /Stillorgan/ }).getAttribute('aria-pressed')).toBe('true')
  })

  it('a persisted scope naming a studio the caller can no longer read falls back to All', async () => {
    window.localStorage.setItem('un1t.mail.scope.me-1', 'c0000000-0000-4000-8000-00000000000c')
    stubMultiNetwork(defaultMultiState())
    renderMulti()
    await screen.findByText('Subject ha-1') // All mode's digest sections
    expect(screen.getByRole('button', { name: /All locations/ }).getAttribute('aria-pressed')).toBe('true')
  })

  it('?loc= wins over the stored scope, validated like ?c=', async () => {
    window.localStorage.setItem('un1t.mail.scope.me-1', LOC_A)
    currentSearchParams = new URLSearchParams(`loc=${LOC_B}`)
    stubMultiNetwork(defaultMultiState())
    renderMulti()
    await screen.findByText('Subject st-1')
    expect(scopedListCalls(LOC_B).length).toBeGreaterThan(0)
    expect(scopedListCalls(LOC_A)).toHaveLength(0)
  })

  it('a garbage ?loc= is ignored outright', async () => {
    currentSearchParams = new URLSearchParams('loc=..%2F..%2Fetc')
    stubMultiNetwork(defaultMultiState())
    renderMulti()
    await screen.findByText('Subject ha-1') // fell through to the default: All
    expect(calls.every(c => !c.url.includes('..'))).toBe(true)
  })

  it('keeps the LAST GOOD needs-reply total when a partial digest answers null', async () => {
    const state = stubMultiNetwork(defaultMultiState())
    renderMulti()
    await screen.findByText('Subject ha-1')
    expect(screen.getByRole('button', { name: /All locations/ }).textContent).toContain('4')
    // Stillorgan blips: the digest goes partial, total null.
    state.unavailable = [LOC_B]
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    await screen.findByText(/couldn’t be reached/)
    // The badge still says 4 — never 0, never blank, while a studio is dark.
    expect(screen.getByRole('button', { name: /All locations/ }).textContent).toContain('4')
    // And the dark studio's own tile shows NO count at all.
    const stillTile = screen.getByRole('button', { name: /^Stillorgan$/ })
    expect(stillTile.textContent).toBe('Stillorgan')
  })

  it('an unavailable studio renders an inline error whose retry refetches the digest', async () => {
    const state = stubMultiNetwork(defaultMultiState())
    state.unavailable = [LOC_B]
    renderMulti()
    await screen.findByText(/couldn’t be reached/)
    const before = digestCalls().length
    state.unavailable = []
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await screen.findByText('Subject st-1')
    expect(digestCalls().length).toBeGreaterThan(before)
  })

  it('search in All mode fans out per studio and groups the results; one failed studio does not sink the rest', async () => {
    const state = stubMultiNetwork(defaultMultiState())
    state.failSearchFor = [LOC_A]
    renderMulti()
    await screen.findByText('Subject ha-1')
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'freeze' } })
    await waitFor(() => {
      expect(calls.some(c => c.url.includes(`location_id=${LOC_A}`) && c.url.includes('q=freeze'))).toBe(true)
      expect(calls.some(c => c.url.includes(`location_id=${LOC_B}`) && c.url.includes('q=freeze'))).toBe(true)
    })
    // Stillorgan's matches render under its header; Hatch shows the error.
    await screen.findByText(/couldn’t be reached/)
    const still = screen.getByRole('region', { name: 'Stillorgan' })
    expect(within(still).getByText('Subject st-1')).toBeTruthy()
  })

  it('j walks the flat order ACROSS sections, and e archives via the row-id route', async () => {
    stubMultiNetwork(defaultMultiState())
    renderMulti()
    await screen.findByText('Subject ha-1')
    await flushEffects()
    fireEvent.keyDown(window, { key: 'j' }) // → ha-1
    await flushEffects()
    fireEvent.keyDown(window, { key: 'j' }) // → ha-2
    await flushEffects()
    fireEvent.keyDown(window, { key: 'j' }) // crosses the section boundary → st-1
    await flushEffects()
    fireEvent.keyDown(window, { key: 'e' })
    await waitFor(() => expect(postsTo('/api/email/mail/st-1/archive')).toHaveLength(1))
    // The archived row leaves its section on the digest refetch.
    await waitFor(() => expect(screen.queryByText('Subject st-1')).toBeNull())
  })

  it('compose from All mode gathers every studio’s accounts and labels them by studio', async () => {
    stubMultiNetwork(defaultMultiState())
    renderMulti()
    await screen.findByText('Subject ha-1')
    fireEvent.click(screen.getByRole('button', { name: /New email/i }))
    // The gather: one scoped list call per studio (no q, no view).
    await waitFor(() => {
      expect(scopedListCalls(LOC_A).length).toBeGreaterThan(0)
      expect(scopedListCalls(LOC_B).length).toBeGreaterThan(0)
    })
    const fromSelect = await screen.findByLabelText(/From/)
    const labels = within(fromSelect).getAllByRole('option').map(o => o.textContent)
    expect(labels.some(l => l.startsWith('Hatch Street · accounts@hatch.ie'))).toBe(true)
    expect(labels.some(l => l.startsWith('Stillorgan · Info'))).toBe(true)
  })
})
