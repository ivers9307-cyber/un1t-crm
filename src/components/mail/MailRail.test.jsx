// @vitest-environment jsdom
//
// MAIL-RAIL.1 — the rail replaces the view pills AND the account tab strip that
// sat along the top of the surface. Presentational: props in, callbacks out.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, cleanup, screen } from '@testing-library/react'
import MailRail from './MailRail'

const MAILBOXES = [
  { id: 'mb-1', label: 'Studio', address: 'studio@un1t.com', is_default: true },
  { id: 'mb-2', label: 'Accounts', address: 'accounts@un1t.com' },
]

function renderRail(over = {}) {
  const props = {
    views: [
      { id: 'inbox', label: 'Inbox', count: 18 },
      { id: 'needs_reply', label: 'Needs reply', count: 1 },
      { id: 'archived', label: 'Archived', count: 11 },
    ],
    viewId: 'inbox',
    onView: vi.fn(),
    mailboxes: MAILBOXES,
    mailboxId: null,
    onMailbox: vi.fn(),
    locationLabel: 'Hatch Street',
    ...over,
  }
  render(<MailRail {...props} />)
  return props
}

beforeEach(() => cleanup())

describe('MailRail', () => {
  // MAIL-SPAM.1 — every view has an icon. `sent` shipped without one (an
  // audit item: VIEW_ICONS never learnt the view MAIL-SENT.1 added) and the
  // new `spam` view must not repeat that. The icon is the one thing the rail
  // renders per view that is not text, so its presence is asserted directly.
  it('renders an icon for every view, sent and spam included', () => {
    renderRail({
      views: [
        { id: 'inbox', label: 'Inbox', count: 18 },
        { id: 'needs_reply', label: 'Needs reply', count: 1 },
        { id: 'sent', label: 'Sent', count: null },
        { id: 'archived', label: 'Archived', count: 11 },
        { id: 'spam', label: 'Spam', count: null },
      ],
    })
    for (const label of ['Inbox', 'Needs reply', 'Sent', 'Archived', 'Spam']) {
      const btn = screen.getByRole('button', { name: new RegExp(`^${label}`) })
      expect(btn.querySelector('svg'), `${label} has no icon`).toBeTruthy()
    }
  })

  it('lists every view with its count', () => {
    renderRail()
    expect(screen.getByRole('button', { name: /Inbox/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Needs reply/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Archived/ })).toBeTruthy()
    expect(screen.getByText('18')).toBeTruthy()
  })

  it('marks the active view, and only it', () => {
    renderRail({ viewId: 'archived' })
    const current = screen.getAllByRole('button').filter(b => b.getAttribute('aria-current') === 'true')
    expect(current).toHaveLength(1)
    expect(current[0].textContent).toMatch(/Archived/)
  })

  it('calls back with the view id', () => {
    const p = renderRail()
    screen.getByRole('button', { name: /Archived/ }).click()
    expect(p.onView).toHaveBeenCalledWith('archived')
  })

  it('lists the accounts and calls back with the mailbox id', () => {
    const p = renderRail()
    screen.getByRole('button', { name: /Accounts/ }).click()
    expect(p.onMailbox).toHaveBeenCalledWith('mb-2')
  })

  // A count of zero is information — "nothing is waiting" — but a count that
  // could not be read is not, and rendering it as 0 would be a lie.
  it('renders a zero count but omits an unknown one', () => {
    renderRail({ views: [
      { id: 'inbox', label: 'Inbox', count: 0 },
      { id: 'needs_reply', label: 'Needs reply', count: null },
    ] })
    expect(screen.getByText('0')).toBeTruthy()
    expect(screen.queryByText('null')).toBeNull()
  })

  // 🔴 Both halves of this matter, and the given suite caught neither.
  // `count != null` would let a non-number (e.g. a stringified count from an
  // un-coerced API response) through unchanged; and a bare `{count && …}`
  // renders `0` as a raw text node — React drops `null`/`false`/`undefined`
  // as children but PRINTS `0` — so the badge would lose its span and its
  // styling while a `getByText('0')` assertion kept right on passing. Assert
  // the ELEMENT the zero lives in, not just the text.
  it('renders a zero count as a styled badge, and ignores a non-numeric count', () => {
    renderRail({ views: [
      { id: 'inbox', label: 'Inbox', count: 0 },
      { id: 'archived', label: 'Archived', count: '11' },
    ] })
    // The zero is a real element carrying the count's styling, not a stray
    // text node dropped straight into the button by `{0 && …}`.
    const zero = screen.getByText('0')
    expect(zero.tagName).toBe('SPAN')
    expect(zero.className).toMatch(/tabular-nums/)
    // A string is not a count — `typeof count === 'number'` is the guard,
    // not truthiness or a null check.
    expect(screen.queryByText('11')).toBeNull()
  })

  // One account is not a choice, and a switcher offering it is furniture.
  it('hides the account section when there is only one account', () => {
    renderRail({ mailboxes: [MAILBOXES[0]] })
    expect(screen.queryByText('Accounts')).toBeNull()
  })

  it('names the studio, so an operator with two locations knows whose mail this is', () => {
    renderRail()
    expect(screen.getByText('Hatch Street')).toBeTruthy()
  })
})

// MAIL-ALLLOC.1 — the location tiles at the head of the rail.
describe('MailRail — location tiles', () => {
  const TILES = [
    { id: 'all', name: 'All locations', count: 5 },
    { id: 'loc-a', name: 'Hatch Street', count: 4 },
    { id: 'loc-b', name: 'Stillorgan', count: 1 },
  ]

  it('renders one tile per entry and calls back with the scope', () => {
    const p = renderRail({ tiles: TILES, scope: 'all', onScope: vi.fn(), locationLabel: null })
    screen.getByRole('button', { name: /Stillorgan/ }).click()
    expect(p.onScope).toHaveBeenCalledWith('loc-b')
    screen.getByRole('button', { name: /All locations/ }).click()
    expect(p.onScope).toHaveBeenCalledWith('all')
  })

  it('marks the active tile with aria-pressed, not aria-current — the view keeps the rail’s one "where am I"', () => {
    renderRail({ tiles: TILES, scope: 'loc-a', onScope: vi.fn() })
    const tile = screen.getByRole('button', { name: /Hatch Street/ })
    expect(tile.getAttribute('aria-pressed')).toBe('true')
    expect(tile.getAttribute('aria-current')).toBeNull()
    const current = screen.getAllByRole('button').filter(b => b.getAttribute('aria-current') === 'true')
    expect(current).toHaveLength(1) // still the view, and only the view
  })

  it('shows a needs-reply chip only above zero — 0 and unknown both render nothing', () => {
    renderRail({
      tiles: [
        { id: 'all', name: 'All locations', count: null }, // never known yet
        { id: 'loc-a', name: 'Hatch Street', count: 4 },
        { id: 'loc-b', name: 'Stillorgan', count: 0 },
      ],
      scope: 'all', onScope: vi.fn(),
      views: [{ id: 'inbox', label: 'Inbox', count: null }],
    })
    expect(screen.getByText('4')).toBeTruthy()
    expect(screen.queryByText('0')).toBeNull()
    expect(screen.getByRole('button', { name: /All locations/ }).textContent).toBe('All locations')
  })

  it('does not render tiles for fewer than two studios — a single-location rail stays byte-for-byte', () => {
    renderRail({ tiles: [TILES[0], TILES[1]], scope: 'all', onScope: vi.fn() })
    expect(screen.queryByText('All locations')).toBeNull()
    expect(screen.queryByText('Location')).toBeNull()
    // The plain location label renders instead, exactly as before.
    expect(screen.getByText('Hatch Street')).toBeTruthy()
  })

  it('replaces the account filter with the disclosure line in All mode', () => {
    renderRail({ tiles: TILES, scope: 'all', onScope: vi.fn(), mailboxes: [] })
    expect(screen.getByText(/Pick a studio to filter by account/)).toBeTruthy()
    expect(screen.queryByText('Accounts')).toBeNull()
  })

  it('shows the account filter again once scoped to one studio', () => {
    renderRail({ tiles: TILES, scope: 'loc-a', onScope: vi.fn() })
    expect(screen.queryByText(/Pick a studio to filter by account/)).toBeNull()
    expect(screen.getByRole('button', { name: 'All accounts' })).toBeTruthy()
  })
})
