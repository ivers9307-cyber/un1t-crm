// @vitest-environment jsdom
//
// INBOX-SURFACE.C — the per-account A/B switch, measured against the bar that
// matters:
//
//   An owner who moves accounts@ must not afterwards have to guess where their
//   mail went, and a colleague who never touched the switch must be able to
//   find out from this screen alone.
//
// That is a copy problem as much as a code one, so this file renders the real
// card and asserts what is ON THE SCREEN — the surface each account is on, both
// surfaces named in the confirm before anything is written, and the PATCH body
// that actually goes on the wire.
//
// The confirm is part of the contract, not decoration. The visible effect of a
// move is a tab going empty for everybody else in the studio, and this is the
// one moment we get to say so before it happens.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup, fireEvent, within } from '@testing-library/react'
import EmailMailboxesCard from './EmailMailboxesCard'

const LOC = 'a0000000-0000-0000-0000-000000000001'

/** An ordinary Postmark-routed account, left where mig 575's DEFAULT puts it. */
const ON_TICKETS = {
  id: 'mb-tickets',
  address: 'accounts@hatchstreetfitness.com',
  label: 'Accounts',
  is_default: true,
  active: true,
  ingress: 'postmark',
  egress: 'postmark',
  surface: 'tickets',
  access: [],
  reachability: null,
}

/** The trial account: moved, and connected over IMAP so write-back applies. */
const ON_MAIL = {
  id: 'mb-mail',
  address: 'hatchstreet@un1t.com',
  label: 'Hatch Street',
  is_default: false,
  active: true,
  ingress: 'imap',
  egress: 'smtp',
  surface: 'inbox',
  access: [],
  reachability: null,
}

/**
 * A row from BEFORE mig 575 — no `surface` key at all. The card must read it as
 * a ticket-surface account, matching the column's own DEFAULT, or every
 * existing studio's screen changes the day the migration lands.
 */
const NO_SURFACE_YET = { ...ON_TICKETS, id: 'mb-legacy', label: 'Legacy', surface: undefined }

let patches
function mockFetch(mailboxes) {
  patches = []
  global.fetch = vi.fn(async (url, init) => {
    const u = String(url)
    if (init?.method === 'PATCH') {
      patches.push({ url: u, body: JSON.parse(init.body) })
      return { ok: true, status: 200, json: async () => ({ success: true, data: { mailbox: {} } }) }
    }
    if (u.includes('/email/mailboxes')) {
      return { ok: true, status: 200, json: async () => ({ success: true, data: { mailboxes, staff: [] } }) }
    }
    // Storage loads in parallel on the same card; an empty answer keeps it out
    // of the way of what is being asserted here.
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

// The card's intro paragraph links both surfaces too — deliberately, it is where
// an operator learns the two exist — so every per-account assertion is scoped to
// that account's own row rather than to the whole card.
const rowFor = (mailbox) => within(screen.getByTestId(`surface-${mailbox.id}`))

beforeEach(() => { vi.clearAllMocks() })
afterEach(() => {
  cleanup()
  delete global.fetch
  delete window.confirm
})

describe('where an account’s mail appears', () => {
  it('names the surface for an account on the ticket queue', async () => {
    await renderCard([ON_TICKETS])
    const row = rowFor(ON_TICKETS)
    expect(row.getByText(/Mail for this account appears in/i)).toBeTruthy()
    expect(row.getByRole('link', { name: 'Email inbox' }).getAttribute('href'))
      .toBe('/communications/tickets')
  })

  it('names the surface for a moved account, and links the right page', async () => {
    await renderCard([ON_MAIL])
    // NOT /communications/inbox — that has been the WhatsApp + Instagram queue
    // since UIX-P1b. A link pointing there would land the operator in a queue
    // holding none of the mail they came looking for.
    expect(rowFor(ON_MAIL).getByRole('link', { name: 'Mail' }).getAttribute('href'))
      .toBe('/communications/mail')
  })

  it('chips ONLY the moved accounts, so a scan finds them', async () => {
    await renderCard([ON_TICKETS, ON_MAIL])
    // The chip is inside the moved account's header line. One chip, not two:
    // a chip on every row is noise on the common case.
    // The intro paragraph links both surfaces by name, so the chip is
    // identified by being a SPAN rather than by the word alone.
    const chips = screen.getAllByText('Mail').filter(el => el.tagName === 'SPAN')
    expect(chips).toHaveLength(1)
  })

  it('reads a row with NO surface value as a ticket-surface account', async () => {
    // The pre-migration shape. Applying mig 575 must change nothing on screen.
    await renderCard([NO_SURFACE_YET])
    const row = rowFor(NO_SURFACE_YET)
    expect(row.getByRole('link', { name: 'Email inbox' })).toBeTruthy()
    expect(row.getByRole('button', { name: /Move to Mail/i })).toBeTruthy()
  })

  it('says the account is worked in ONE place, and that moving is reversible', async () => {
    await renderCard([ON_TICKETS])
    // The two facts an operator needs before they touch it: their colleagues
    // lose it from the tab they use, and nothing is destroyed.
    expect(screen.getByText(/takes it out of Email inbox/i)).toBeTruthy()
    expect(screen.getByText(/Nothing is deleted and moving it back/i)).toBeTruthy()
  })

  it('warns that the mail surface writes back to a CONNECTED mailbox', async () => {
    // The connector has been strictly read-only until now, so an operator's
    // real mailbox visibly changing is a consequence they have to opt into
    // knowingly. Archive only — deleting is never in scope.
    await renderCard([{ ...ON_MAIL, surface: 'tickets' }])
    expect(screen.getByText(/marks it read in the real mailbox/i)).toBeTruthy()
    expect(screen.getByText(/Nothing is ever deleted there/i)).toBeTruthy()
  })

  it('does NOT claim write-back for an account that is not connected', async () => {
    await renderCard([ON_TICKETS])
    expect(screen.queryByText(/marks it read in the real mailbox/i)).toBeNull()
  })
})

describe('moving an account', () => {
  it('names BOTH surfaces in the confirm before anything is written', async () => {
    await renderCard([ON_TICKETS])
    const seen = []
    window.confirm = vi.fn((msg) => { seen.push(msg); return false })

    fireEvent.click(screen.getByRole('button', { name: /Move to Mail/i }))

    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatch(/accounts@hatchstreetfitness\.com/)
    expect(seen[0]).toMatch(/answered in Mail/)
    expect(seen[0]).toMatch(/stops appearing in Email inbox/)
    expect(seen[0]).toMatch(/deleted/)
    // Cancelled means cancelled — no write at all.
    expect(patches).toEqual([])
  })

  it('PATCHes only `surface` when confirmed', async () => {
    await renderCard([ON_TICKETS])
    window.confirm = vi.fn(() => true)

    fireEvent.click(screen.getByRole('button', { name: /Move to Mail/i }))
    await waitFor(() => expect(patches).toHaveLength(1))

    expect(patches[0].url).toBe(`/api/locations/${LOC}/email/mailboxes/${ON_TICKETS.id}`)
    // Nothing else rides along: a move must not silently rename, re-default or
    // deactivate the account it is moving.
    expect(patches[0].body).toEqual({ surface: 'inbox' })
  })

  it('offers the return trip from the mail surface', async () => {
    await renderCard([ON_MAIL])
    window.confirm = vi.fn(() => true)

    fireEvent.click(screen.getByRole('button', { name: /Move to Email inbox/i }))
    await waitFor(() => expect(patches).toHaveLength(1))
    expect(patches[0].body).toEqual({ surface: 'tickets' })
  })

  it('offers the switch on a DEACTIVATED account too', async () => {
    // Refusing here would strand a deactivated account on whichever surface it
    // happened to be on when somebody switched it off.
    await renderCard([{ ...ON_MAIL, active: false }])
    expect(screen.getByRole('button', { name: /Move to Email inbox/i })).toBeTruthy()
  })
})
