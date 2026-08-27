// @vitest-environment jsdom
//
// MAILBOX-UNREACHABLE.1 — the bar this whole change is measured against:
//
//   An owner opening Settings → Locations → Stillorgan → Email must be able to
//   tell, knowing none of the history, that stillorgan@un1t.com cannot receive
//   and what to do about it.
//
// So this file renders the real card against the real route shape and asserts
// what is ON THE SCREEN, not what the API returned. Two properties, and the
// second is load-bearing:
//
//   1. The unreachable default is named, explained and remedied, WITHOUT
//      anyone expanding anything. The connection panel below collapses; a
//      truth folded behind a toggle is not a truth anybody was told.
//   2. A reachable mailbox with ZERO mail renders completely clean. That is
//      the difference between a warning people act on and a warning people
//      learn to scroll past.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup } from '@testing-library/react'
import EmailMailboxesCard from './EmailMailboxesCard'

const LOC = 'a0000000-0000-0000-0000-000000000001'

// The verdict exactly as src/lib/mail/mailbox-reachability.js builds it for the
// live Stillorgan row (its own tests pin the wording; this file pins that the
// wording reaches the screen).
const DEAD = {
  id: 'mb-dead',
  address: 'stillorgan@un1t.com',
  label: 'Inbox',
  is_default: true,
  active: true,
  ingress: 'postmark',
  egress: 'postmark',
  access: [],
  reachability: {
    state: 'unreachable',
    domain: 'un1t.com',
    deliversTo: 'aspmx.l.google.com',
    notice: {
      tone: 'error',
      chip: 'Cannot receive',
      headline: 'This address cannot receive mail into the CRM',
      detail:
        'un1t.com delivers its mail to aspmx.l.google.com, not to this platform. It is also this ' +
        "studio's DEFAULT account, so every campaign tells members to reply to it.",
      remedy: 'Connect this account’s mailbox login below, or make a working address the default.',
    },
  },
}

const ALIVE = {
  id: 'mb-alive',
  address: 'accounts@hatchstreetfitness.com',
  label: 'Accounts',
  is_default: false,
  active: true,
  ingress: 'postmark',
  egress: 'postmark',
  access: [],
  reachability: { state: 'ok', domain: 'hatchstreetfitness.com', deliversTo: 'inbound.postmarkapp.com', notice: null },
}

function mockFetch(mailboxes) {
  global.fetch = vi.fn(async (url) => {
    const u = String(url)
    if (u.includes('/email/mailboxes')) {
      return { ok: true, status: 200, json: async () => ({ success: true, data: { mailboxes, staff: [] } }) }
    }
    // Storage lives on the same card and loads in parallel; an empty answer
    // keeps it out of the way of what is being asserted here.
    return {
      ok: true, status: 200,
      json: async () => ({ success: true, data: { quota_bytes: 5e9, mailboxes: [], unfiled: null } }),
    }
  })
}

const renderCard = async (mailboxes) => {
  mockFetch(mailboxes)
  render(<EmailMailboxesCard locationId={LOC} />)
  await waitFor(() => expect(screen.getByText(mailboxes[0].label)).toBeTruthy())
}

beforeEach(() => { vi.clearAllMocks() })
afterEach(() => { cleanup(); delete global.fetch })

describe('an address that cannot receive', () => {
  it('says so on the row, unprompted', async () => {
    await renderCard([DEAD])
    expect(screen.getByText(/cannot receive mail into the CRM/i)).toBeTruthy()
  })

  it('puts "Cannot receive" beside "Default" — the pairing is the problem', async () => {
    await renderCard([DEAD])
    expect(screen.getByText('Default')).toBeTruthy()
    expect(screen.getByText('Cannot receive')).toBeTruthy()
  })

  it('names the domain and where its mail actually goes, so the claim is checkable', async () => {
    await renderCard([DEAD])
    expect(screen.getByText(/aspmx\.l\.google\.com/)).toBeTruthy()
  })

  it('tells the owner what to do about it', async () => {
    await renderCard([DEAD])
    expect(screen.getByText(/mailbox login below/i)).toBeTruthy()
  })

  it('needs no expanding — the connection panel is still collapsed', async () => {
    await renderCard([DEAD])
    // The panel's own toggle is present but unopened; the warning above is not
    // inside it.
    const toggle = screen.getByRole('button', { name: /mailbox connection/i })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(screen.getByText(/cannot receive mail into the CRM/i)).toBeTruthy()
  })
})

describe('an address that can receive', () => {
  it('renders no warning at all, however little mail it has had', async () => {
    await renderCard([ALIVE])
    expect(screen.queryByText(/cannot receive/i)).toBeNull()
    expect(screen.queryByRole('img', { hidden: true, name: /warning/i })).toBeNull()
  })

  it('is untouched when it sits beside a broken one', async () => {
    await renderCard([DEAD, ALIVE])
    // Exactly one warning on the screen, and it belongs to the dead address.
    expect(screen.getAllByText(/cannot receive mail into the CRM/i)).toHaveLength(1)
    expect(screen.getAllByText('Cannot receive')).toHaveLength(1)
  })
})

describe('when the platform could not tell', () => {
  it('says nothing rather than guessing', async () => {
    // A DNS fault arrives as a null verdict — the same shape as an older
    // server that predates this field.
    await renderCard([{ ...DEAD, reachability: null }])
    expect(screen.queryByText(/cannot receive/i)).toBeNull()
  })
})
