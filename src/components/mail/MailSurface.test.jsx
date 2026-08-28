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
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const renderSurface = () =>
  render(<MailSurface locationId={LOC} locationName="UN1T Hatch Street" userId="me-1" />)

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
    fireEvent.keyDown(document.body, { key: 'j' })
    await screen.findByText('Message on Membership freeze')
    fireEvent.keyDown(document.body, { key: 'j' })
    await screen.findByText('Message on Class times')
  })

  it('k moves back, and does not wrap off the top', async () => {
    renderSurface()
    await screen.findByText('Membership freeze')
    fireEvent.keyDown(document.body, { key: 'j' })
    await screen.findByText('Message on Membership freeze')
    // Already on the first conversation — k must do nothing rather than jump
    // to the oldest one with no visible cause.
    fireEvent.keyDown(document.body, { key: 'k' })
    await screen.findByText('Message on Membership freeze')
  })

  it('e archives the open conversation', async () => {
    renderSurface()
    fireEvent.click(await screen.findByText('Membership freeze'))
    await screen.findByText('Message on Membership freeze')
    fireEvent.keyDown(document.body, { key: 'e' })
    await waitFor(() => expect(postsTo('/archive')).toHaveLength(1))
  })

  // 🔴 The one that matters.
  it('NEVER archives while the operator is typing a reply', async () => {
    renderSurface()
    fireEvent.click(await screen.findByText('Membership freeze'))
    await screen.findByText('Message on Membership freeze')

    const composer = document.getElementById('ticket-composer')
    expect(composer).toBeTruthy()
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

    fireEvent.keyDown(document.body, { key: 'e' })
    fireEvent.keyDown(document.body, { key: 'u' })

    expect(postsTo('/archive')).toHaveLength(0)
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('ignores autorepeat, so holding e does not walk the list archiving', async () => {
    renderSurface()
    fireEvent.click(await screen.findByText('Membership freeze'))
    await screen.findByText('Message on Membership freeze')

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

  it('starts compact and remembers a switch to comfortable', async () => {
    renderSurface()
    await screen.findByText('Membership freeze')

    expect(screen.getByRole('button', { name: /^Compact$/i }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: /^Comfortable$/i }))
    expect(window.localStorage.getItem('un1t.mail.density')).toBe('comfortable')
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
    // as in the thread heading: two instances of the subject on screen, not
    // one. The old behaviour would drop to one (list row gone) for a moment
    // and then bounce back once the quiet refetch below landed.
    await waitFor(() => expect(screen.getAllByText('Membership freeze')).toHaveLength(2))
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
