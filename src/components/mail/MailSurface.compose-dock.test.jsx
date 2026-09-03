// @vitest-environment jsdom
//
// MAIL-DOCK.2 — compose joins the dock, end to end against a stubbed network.
//
// THREE THINGS ARE WORTH THIS MUCH MACHINERY:
//
// 1. 🔴 A DIRTY DRAFT IS SACRED. Esc minimises a dirty compose — full → dock
//    → min, the bar is the floor — and NEVER discards; only ✕, behind
//    TicketCompose's own confirm, can throw typed words away. Get that
//    backwards once and an operator loses an email they had already written.
//
// 2. ONE BOTTOM-RIGHT SLOT. Compose and the reader trade the corner by
//    auto-minimising each other — never by closing each other. Both drafts
//    and threads stay mounted through every swap.
//
// 3. THE GUARD LIFTS WITH THE CARD. j/k/e/u are inert under an open compose
//    card exactly as they were under the modal, and flow again the moment it
//    is a bar — with j/k retargeting the reader and never touching compose.
//
// The shell variant is frozen at open from matchMedia, so this file stubs
// md+ per test; the LAST test pins the below-md Modal, byte-for-byte.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent, act } from '@testing-library/react'

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
import { COMPOSE_MODE_KEY } from './mail-display'

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

let calls
function stubNetwork() {
  calls = []
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    calls.push({ url: String(url), method: init?.method || 'GET', body: init?.body ? JSON.parse(init.body) : null })
    const u = String(url)
    if (u.startsWith('/api/email/mail?')) {
      return json({
        success: true,
        data: {
          mailboxes: [MAILBOX],
          conversations: [CONV_A, CONV_B],
          next_before: null,
          needs_reply_count: 1,
          counts_unavailable: false,
          counts_partial: false,
        },
      })
    }
    if (u.startsWith('/api/email/tickets/') && u.endsWith('compose')) {
      return json({ success: true, data: { ticket: { ...CONV_A, id: 'conv-new', subject: 'Fresh outbound' }, ticket_id: 'conv-new' } })
    }
    if (u.startsWith('/api/email/tickets/')) {
      const id = u.split('/')[4]
      const row = [CONV_A, CONV_B].find(c => c.id === id) || { ...CONV_A, id }
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
      return json({
        success: true,
        data: {
          conversation: { ...([CONV_A, CONV_B].find(c => c.id === id) || CONV_A), status: 'closed', archived: true },
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
  window.localStorage.clear()
  window.HTMLElement.prototype.scrollIntoView = vi.fn()
  stubNetwork()
  routerReplace = vi.fn()
  routerPush = vi.fn()
  currentSearchParams = new URLSearchParams()
  // The dock variant is decided by isMdUp() AT OPEN — md+ unless a test says
  // otherwise. jsdom has no matchMedia of its own, so this stub IS the
  // desktop; deleting it (the last test) is the mobile.
  window.matchMedia = vi.fn(() => ({ matches: true }))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  delete window.matchMedia
})

const renderSurface = () =>
  render(<MailSurface locationId={LOC} locationName="UN1T Hatch Street" userId="me-1" />)

// The DEFLAKE idiom from MailSurface.test.jsx: the window keydown listener is
// re-attached in a passive effect closing over state — flush before pressing.
const flushEffects = () => act(async () => {})

const composeCard = () => document.querySelector('[data-compose-mode]')
const readerCard = () => document.querySelector('[data-reader-mode]')
const postsTo = (fragment) => calls.filter(c => c.method === 'POST' && c.url.includes(fragment))

async function openList() {
  renderSurface()
  return await screen.findByText('Membership freeze')
}

async function openComposeDock() {
  fireEvent.click(screen.getByRole('button', { name: /New email/i }))
  await flushEffects()
  return composeCard()
}

const subjectField = () => screen.getByPlaceholderText('What this is about')
const bodyField = () => screen.getByPlaceholderText('Write the email…')
const dirtyCompose = () => fireEvent.change(bodyField(), { target: { value: 'Half a reply nobody else has a copy of.' } })

describe('MailSurface — compose opens as a docked card at md+', () => {
  it('renders ComposeDock, not the Modal, and titles it live from the subject', async () => {
    await openList()
    const card = await openComposeDock()
    expect(card).toBeTruthy()
    expect(card.getAttribute('data-compose-mode')).toBe('dock')
    expect(screen.queryByRole('dialog')).toBeNull()
    // The typed subject retitles the bar live; empty says New email.
    expect(card.textContent).toContain('New email')
    fireEvent.change(subjectField(), { target: { value: 'Re: your trial' } })
    expect(card.firstElementChild.textContent).toContain('Re: your trial')
    // The submit footer moved inside the card bottom.
    expect(card.contains(screen.getByRole('button', { name: /Send|Waiting/ }))).toBe(true)
  })

  it('opens in the PERSISTED mode — an operator who writes full-screen gets full-screen', async () => {
    window.localStorage.setItem(COMPOSE_MODE_KEY, 'full')
    await openList()
    const card = await openComposeDock()
    expect(card.getAttribute('data-compose-mode')).toBe('full')
  })

  it('⤢ persists full for next time; Esc stepping back down does NOT', async () => {
    await openList()
    await openComposeDock()
    fireEvent.click(screen.getByRole('button', { name: 'Expand to full screen' }))
    expect(window.localStorage.getItem(COMPOSE_MODE_KEY)).toBe('full')
    expect(composeCard().getAttribute('data-compose-mode')).toBe('full')
    // Esc (dirty, so it steps rather than closes) is a dismissal, not a preference.
    dirtyCompose()
    fireEvent.keyDown(bodyField(), { key: 'Escape' })
    expect(composeCard().getAttribute('data-compose-mode')).toBe('dock')
    expect(window.localStorage.getItem(COMPOSE_MODE_KEY)).toBe('full')
  })
})

describe('MailSurface — 🔴 the dirty Esc ladder never discards', () => {
  it('Esc on a dirty dock card MINIMISES — confirm never fires, the draft survives', async () => {
    const confirmSpy = vi.fn(() => { throw new Error('confirm must not be consulted by Esc') })
    vi.stubGlobal('confirm', confirmSpy)
    await openList()
    await openComposeDock()
    dirtyCompose()
    fireEvent.keyDown(bodyField(), { key: 'Escape' })
    expect(composeCard().getAttribute('data-compose-mode')).toBe('min')
    expect(confirmSpy).not.toHaveBeenCalled()
    // Mounted, hidden — the words are still there.
    expect(bodyField().value).toContain('Half a reply')
  })

  it('Esc on the dirty minimised bar does nothing further — the bar is the floor', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true))
    await openList()
    await openComposeDock()
    dirtyCompose()
    fireEvent.keyDown(bodyField(), { key: 'Escape' })
    expect(composeCard().getAttribute('data-compose-mode')).toBe('min')
    await flushEffects()
    fireEvent.keyDown(composeCard().firstElementChild, { key: 'Escape' })
    expect(composeCard()).toBeTruthy()
    expect(composeCard().getAttribute('data-compose-mode')).toBe('min')
  })

  it('Esc on the dirty bar leaves the RESTORE TARGET alone — full still restores full', async () => {
    window.localStorage.setItem(COMPOSE_MODE_KEY, 'full')
    await openList()
    await openComposeDock()
    expect(composeCard().getAttribute('data-compose-mode')).toBe('full')
    dirtyCompose()
    // ─ from full: the bar remembers full.
    fireEvent.click(screen.getByRole('button', { name: 'Minimise the email' }))
    expect(composeCard().getAttribute('data-compose-mode')).toBe('min')
    // A stray Esc on the dirty bar is a no-op — it must not quietly rewrite
    // where the bar restores to.
    await flushEffects()
    fireEvent.keyDown(composeCard().firstElementChild, { key: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: 'Restore the email' }))
    expect(composeCard().getAttribute('data-compose-mode')).toBe('full')
  })

  it('Esc on a PRISTINE card closes it silently', async () => {
    const confirmSpy = vi.fn()
    vi.stubGlobal('confirm', confirmSpy)
    await openList()
    await openComposeDock()
    fireEvent.keyDown(subjectField(), { key: 'Escape' })
    expect(composeCard()).toBeNull()
    expect(confirmSpy).not.toHaveBeenCalled()
  })

  it('✕ keeps the dirty-confirm: decline keeps writing, accept discards', async () => {
    vi.stubGlobal('confirm', vi.fn(() => false))
    await openList()
    await openComposeDock()
    dirtyCompose()
    fireEvent.click(screen.getByRole('button', { name: 'Close the email' }))
    expect(composeCard()).toBeTruthy()
    expect(bodyField().value).toContain('Half a reply')
    vi.stubGlobal('confirm', vi.fn(() => true))
    fireEvent.click(screen.getByRole('button', { name: 'Close the email' }))
    expect(composeCard()).toBeNull()
  })

  it('a dirty draft survives minimise → restore with every word intact', async () => {
    await openList()
    await openComposeDock()
    dirtyCompose()
    fireEvent.change(subjectField(), { target: { value: 'Re: your trial' } })
    fireEvent.click(screen.getByRole('button', { name: 'Minimise the email' }))
    expect(composeCard().getAttribute('data-compose-mode')).toBe('min')
    // The bar wears the subject.
    expect(composeCard().firstElementChild.textContent).toContain('Re: your trial')
    fireEvent.click(screen.getByRole('button', { name: 'Restore the email' }))
    expect(composeCard().getAttribute('data-compose-mode')).toBe('dock')
    expect(bodyField().value).toContain('Half a reply')
    expect(subjectField().value).toBe('Re: your trial')
  })
})

describe('MailSurface — one bottom-right slot', () => {
  it('opening compose over an open reader card auto-minimises the reader; its bar survives', async () => {
    const row = await openList()
    fireEvent.click(row)
    await screen.findByText('Message on Membership freeze')
    expect(readerCard().getAttribute('data-reader-mode')).toBe('dock')
    await openComposeDock()
    expect(readerCard().getAttribute('data-reader-mode')).toBe('min')
    // The conversation stays warm — mounted, its subject on the bar.
    expect(readerCard().firstElementChild.textContent).toContain('Membership freeze')
    // The reader's bar steps LEFT of the compose card, which owns right-4.
    // MAILFIX-DOCK.1 — the step quotes the COMPOSE card's own width term
    // (dock-geometry.test.js pins the equality), so the bar stays inside
    // the pane at every width instead of vanishing left of it.
    expect(readerCard().className).toContain('md:right-[calc(1.5rem+min(1120px,calc(100vw-672px)))]')
    expect(composeCard().className).toContain('md:right-4')
    // …and the compose card, seeing the parked bar, takes the RESERVED width
    // — the same 672 term the bar's step quotes. This is the live pairing.
    expect(composeCard().className).toContain('md:w-[min(1120px,calc(100vw-672px))]')
  })

  it('restoring the reader auto-minimises compose — the typed draft waits in the bar', async () => {
    const row = await openList()
    fireEvent.click(row)
    await screen.findByText('Message on Membership freeze')
    await openComposeDock()
    dirtyCompose()
    // Click the reader's minimised bar to restore it.
    fireEvent.click(readerCard().firstElementChild)
    expect(readerCard().getAttribute('data-reader-mode')).toBe('dock')
    expect(composeCard().getAttribute('data-compose-mode')).toBe('min')
    expect(bodyField().value).toContain('Half a reply')
    // …and the compose bar now stacks left of the reader CARD — clamped to
    // the pane's left margin so the parked draft never leaves the viewport
    // and never sits over the sidebar (MAILFIX-DOCK.1).
    expect(composeCard().className).toContain('md:right-[min(calc(4.5rem+1120px),calc(100vw-624px))]')
  })

  it('restoring COMPOSE from its bar takes the slot back — the reader card yields to min', async () => {
    const row = await openList()
    fireEvent.click(row)
    await screen.findByText('Message on Membership freeze')
    await openComposeDock()
    dirtyCompose()
    // Reader takes the slot back… (compose → bar)
    fireEvent.click(readerCard().firstElementChild)
    expect(readerCard().getAttribute('data-reader-mode')).toBe('dock')
    expect(composeCard().getAttribute('data-compose-mode')).toBe('min')
    // …then compose takes it back again: the reader CARD must yield, or two
    // cards would fight over one corner.
    fireEvent.click(screen.getByRole('button', { name: 'Restore the email' }))
    expect(composeCard().getAttribute('data-compose-mode')).toBe('dock')
    expect(readerCard().getAttribute('data-reader-mode')).toBe('min')
    expect(bodyField().value).toContain('Half a reply')
  })

  it('closing compose restores nothing automatically — the reader stays a bar', async () => {
    const row = await openList()
    fireEvent.click(row)
    await screen.findByText('Message on Membership freeze')
    await openComposeDock()
    fireEvent.keyDown(subjectField(), { key: 'Escape' }) // pristine → close
    expect(composeCard()).toBeNull()
    expect(readerCard().getAttribute('data-reader-mode')).toBe('min')
  })
})

describe('MailSurface — the keyboard guard follows the card, not the open flag', () => {
  it('an open compose CARD keeps e/j/u inert, exactly the modal posture', async () => {
    const row = await openList()
    fireEvent.click(row)
    await screen.findByText('Message on Membership freeze')
    await openComposeDock()
    await flushEffects()
    fireEvent.keyDown(composeCard(), { key: 'e' })
    fireEvent.keyDown(composeCard(), { key: 'j' })
    fireEvent.keyDown(composeCard(), { key: 'u' })
    expect(postsTo('/archive')).toHaveLength(0)
    expect(composeCard()).toBeTruthy()
    expect(readerCard()).toBeTruthy() // 'u' did not clear the selection
  })

  it('a MINIMISED compose lifts the guard: j retargets the reader bar and never touches compose', async () => {
    const row = await openList()
    fireEvent.click(row)
    await screen.findByText('Message on Membership freeze')
    await openComposeDock()
    dirtyCompose()
    fireEvent.click(screen.getByRole('button', { name: 'Minimise the email' }))
    await flushEffects()
    // j moves the (minimised) reader to conv-b — retarget without restoring.
    fireEvent.keyDown(document.body, { key: 'j' })
    await screen.findByText('Message on Class times')
    expect(readerCard().getAttribute('data-reader-mode')).toBe('min')
    expect(readerCard().firstElementChild.textContent).toContain('Class times')
    // Compose untouched: still a bar, draft intact.
    expect(composeCard().getAttribute('data-compose-mode')).toBe('min')
    expect(bodyField().value).toContain('Half a reply')
    // …and e archives the reader's conversation — the guard is genuinely lifted.
    await flushEffects()
    fireEvent.keyDown(document.body, { key: 'e' })
    await flushEffects()
    expect(postsTo('/archive')).toHaveLength(1)
  })
})

describe('MailSurface — below md the Modal composer is byte-for-byte', () => {
  it('opens the plain Modal, no dock chrome, guard exactly as before', async () => {
    delete window.matchMedia // jsdom's truth: no matchMedia, no md+
    await openList()
    fireEvent.click(screen.getByRole('button', { name: /New email/i }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toBeTruthy()
    expect(composeCard()).toBeNull()
    await flushEffects()
    fireEvent.keyDown(dialog, { key: 'e' })
    expect(postsTo('/archive')).toHaveLength(0)
  })
})

// ── Audit F1 (BLOCKER pin) — the empty-state early returns must not unmount
// a dirty compose. The dock leaves the rail clickable mid-draft, so a
// refresh that comes back mailbox-less swaps the tree for an EmptyState —
// the draft has to ride along onto that return path too.
describe('a dirty compose survives the tree collapsing to an empty state', () => {
  it('keeps the typed draft mounted when a refresh answers zero mailboxes', async () => {
    await openList()
    await openComposeDock()
    dirtyCompose()

    // The studio's mailboxes vanish out from under the surface (an admin
    // deactivating the last account) — the next quiet refresh lands it.
    const realFetch = globalThis.fetch
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      if (String(url).startsWith('/api/email/mail?')) {
        return json({
          success: true,
          data: { mailboxes: [], conversations: [], next_before: null, needs_reply_count: 0 },
        })
      }
      return realFetch(url, init)
    }))
    fireEvent(window, new Event('focus'))
    await flushEffects()

    // The tree is now the no-mailboxes EmptyState…
    expect(await screen.findByText(/no email account|not been set up|No email/i)).toBeTruthy()
    // …and the draft is still on screen, word for word.
    expect(bodyField().value).toBe('Half a reply nobody else has a copy of.')
  })
})
