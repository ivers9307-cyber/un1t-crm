// src/components/schedule/RosterChangeLogDrawer.test.jsx
// @vitest-environment jsdom
//
// CHANGELOG.1 — the "Changes since publish" drawer. The sentences are pinned
// in src/lib/roster-change-format.test.js; this is the wiring: what it asks
// for, and what it shows for each answer. jsdom has no layout, so only text,
// roles and presence are asserted. Every findBy waits for something to APPEAR.

import React from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, within, act } from '@testing-library/react'
import RosterChangeLogDrawer from './RosterChangeLogDrawer.jsx'

const change = (over = {}) => ({
  id: 'c1', action: 'assigned', block_date: '2026-09-15', start_time: '06:00:00', end_time: '07:00:00',
  shift_name: 'Morning', coach_name: 'Coach A', actor_name: 'Manager B', self_change: false,
  details: {}, notified_at: '2026-09-15T13:02:00Z', created_at: '2026-09-15T12:58:00Z', ...over,
})

const answer = (status, body) => vi.fn(async () => ({ ok: status >= 200 && status < 300, status, json: async () => body }))
const props = { locationId: 'loc1', periodStart: '2026-09-14', periodEnd: '2026-09-20', periodLabel: '14 Sep – 20 Sep 2026', onClose: () => {} }

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('RosterChangeLogDrawer', () => {
  it('asks for exactly the studio and period on screen, once', async () => {
    global.fetch = answer(200, { success: true, data: { changes: [], truncated: false } })
    render(<RosterChangeLogDrawer {...props} />)
    await screen.findByText(/No changes since this was published/)
    expect(global.fetch).toHaveBeenCalledTimes(1)
    expect(String(global.fetch.mock.calls[0][0])).toBe('/api/schedule/change-log?location_id=loc1&from=2026-09-14&to=2026-09-20')
  })

  it('is a dialog titled with the period', async () => {
    global.fetch = answer(200, { success: true, data: { changes: [], truncated: false } })
    render(<RosterChangeLogDrawer {...props} />)
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Changes since publish')).toBeTruthy()
    expect(within(dialog).getByText('14 Sep – 20 Sep 2026')).toBeTruthy()
  })

  it('lists each change as a sentence, with who made it and whether the coach was told', async () => {
    global.fetch = answer(200, { success: true, data: { truncated: false, changes: [
      change(),
      change({ id: 'c2', action: 'unassigned', coach_name: 'Coach C', notified_at: null }),
    ] } })
    render(<RosterChangeLogDrawer {...props} />)
    const list = await screen.findByTestId('roster-change-list')
    const items = within(list).getAllByRole('listitem')
    expect(items).toHaveLength(2)
    expect(items[0].textContent).toMatch(/Assigned Coach A to Tue 15 Sep 6am/)
    expect(items[0].textContent).toMatch(/told 14:02/)
    expect(items[0].textContent).toMatch(/Manager B · 15 Sep 13:58/)
    expect(items[1].textContent).toMatch(/Removed Coach C from Tue 15 Sep 6am/)
    expect(items[1].textContent).toMatch(/not told yet/)
  })

  it('a row stamped without a message shows NO told chip: not a time nobody was told at', async () => {
    global.fetch = answer(200, { success: true, data: { truncated: false, changes: [
      change({ action: 'unassigned', details: { reason: 'staff_permanent_delete' } }),
      change({ id: 'c2' }),
    ] } })
    render(<RosterChangeLogDrawer {...props} />)
    const items = within(await screen.findByTestId('roster-change-list')).getAllByRole('listitem')
    expect(items[0].textContent).toMatch(/Removed Coach A from Tue 15 Sep 6am \(staff member deleted\)/)
    expect(items[0].textContent).not.toMatch(/told/)
    expect(within(items[0]).queryByTestId('roster-change-told')).toBeNull()
    expect(within(items[1]).getByTestId('roster-change-told').textContent).toBe('told 14:02')
    // Stamped, so it is not counted as somebody still waiting to hear.
    expect(screen.getByTestId('roster-change-summary').textContent).toMatch(/2 changes$/)
  })

  it('counts who has not been told, and says how they will be', async () => {
    global.fetch = answer(200, { success: true, data: { truncated: false, changes: [
      change(), change({ id: 'c2', notified_at: null }), change({ id: 'c3', notified_at: null }),
    ] } })
    render(<RosterChangeLogDrawer {...props} />)
    const summary = await screen.findByTestId('roster-change-summary')
    expect(summary.textContent).toMatch(/3 changes/)
    expect(summary.textContent).toMatch(/2 not told yet/)
    expect(summary.textContent).toMatch(/Publish again to tell them/)
  })

  it('everyone told: no nag', async () => {
    global.fetch = answer(200, { success: true, data: { truncated: false, changes: [change()] } })
    render(<RosterChangeLogDrawer {...props} />)
    const summary = await screen.findByTestId('roster-change-summary')
    expect(summary.textContent).toMatch(/1 change$/)
  })

  it('an empty period says so, and shows no list', async () => {
    global.fetch = answer(200, { success: true, data: { changes: [], truncated: false } })
    render(<RosterChangeLogDrawer {...props} />)
    expect(await screen.findByText(/No changes since this was published/)).toBeTruthy()
    expect(screen.queryByTestId('roster-change-list')).toBeNull()
  })

  it('a refused or failed read shows the ERROR, never the empty state', async () => {
    global.fetch = answer(500, { success: false, error: 'boom' })
    render(<RosterChangeLogDrawer {...props} />)
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/boom/)
    expect(screen.queryByText(/No changes since this was published/)).toBeNull()
  })

  it('a dropped connection is an error too, in words an operator can read', async () => {
    // What a browser's fetch really rejects with when the connection drops.
    global.fetch = vi.fn(async () => { throw new TypeError('Failed to fetch') })
    render(<RosterChangeLogDrawer {...props} />)
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/Network error/)
    expect(alert.textContent).not.toMatch(/Failed to fetch/)
  })

  it('says when the list was cut short', async () => {
    global.fetch = answer(200, { success: true, data: { changes: [change()], truncated: true } })
    render(<RosterChangeLogDrawer {...props} />)
    expect(await screen.findByText(/Showing the most recent 5,000/)).toBeTruthy()
  })

  it('a dead session says so, instead of a bare status code', async () => {
    global.fetch = answer(401, { success: false, error: 'Unauthorized' })
    render(<RosterChangeLogDrawer {...props} />)
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/signed out/i)
  })

  it('a non-JSON failure (an edge 502) still ends the loading state, with the status', async () => {
    global.fetch = vi.fn(async () => ({ ok: false, status: 502, json: async () => { throw new Error('Unexpected token <') } }))
    render(<RosterChangeLogDrawer {...props} />)
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/502/)
    expect(screen.queryByText(/Loading changes/)).toBeNull()
  })

  it('the scrolling list is reachable by keyboard and has a name', async () => {
    global.fetch = answer(200, { success: true, data: { changes: [change()], truncated: false } })
    render(<RosterChangeLogDrawer {...props} />)
    const region = await screen.findByRole('region', { name: 'Changes, newest first' })
    expect(region.getAttribute('tabindex')).toBe('0')
    expect(within(region).getByTestId('roster-change-list')).toBeTruthy()
  })

  it('a staff member who has since left still appears by name', async () => {
    // The API keeps tombstoned and deactivated profiles in this read on
    // purpose; the drawer prints whatever name it is given and never filters.
    global.fetch = answer(200, { success: true, data: { truncated: false, changes: [
      change({ coach_name: 'Coach D (left)', actor_name: 'Manager E (left)' }),
    ] } })
    render(<RosterChangeLogDrawer {...props} />)
    const list = await screen.findByTestId('roster-change-list')
    expect(list.textContent).toMatch(/Assigned Coach D \(left\) to/)
    expect(list.textContent).toMatch(/Manager E \(left\) · /)
  })

  // In production a signed-out request is REDIRECTED to /login by src/proxy.js;
  // fetch follows it and gets 200 + HTML. That used to read "Could not load the
  // changes (200)".
  it('a request redirected to /login reads as signed out', async () => {
    global.fetch = vi.fn(async () => ({ ok: true, status: 200, redirected: true, json: async () => { throw new Error("Unexpected token '<'") } }))
    render(<RosterChangeLogDrawer {...props} />)
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/signed out/i)
    expect(alert.textContent).not.toMatch(/200/)
    expect(screen.queryByText(/No changes since this was published/)).toBeNull()
  })

  it('so does a 200 that is not JSON, even without the redirected flag', async () => {
    global.fetch = vi.fn(async () => ({ ok: true, status: 200, redirected: false, json: async () => { throw new Error("Unexpected token '<'") } }))
    render(<RosterChangeLogDrawer {...props} />)
    expect((await screen.findByRole('alert')).textContent).toMatch(/signed out/i)
  })

  it('a 403 keeps the server\'s own words, and never says signed out', async () => {
    global.fetch = answer(403, { success: false, error: 'Forbidden — location not in your assignments' })
    render(<RosterChangeLogDrawer {...props} />)
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/location not in your assignments/)
    expect(alert.textContent).not.toMatch(/signed out/i)
  })

  it('a late answer for a period that is no longer on screen writes nothing', async () => {
    // Deleting the `cancelled` guard in the drawer's effect must fail this.
    const pending = {}
    global.fetch = vi.fn((url) => new Promise((resolve) => { pending[String(url).includes('from=2026-09-14') ? 'first' : 'second'] = resolve }))
    const reply = (changes) => ({ ok: true, status: 200, json: async () => ({ success: true, data: { changes, truncated: false } }) })

    const { rerender } = render(<RosterChangeLogDrawer {...props} />)
    rerender(<RosterChangeLogDrawer {...props} periodStart="2026-09-21" periodEnd="2026-09-27" periodLabel="21 Sep – 27 Sep 2026" />)
    expect(global.fetch).toHaveBeenCalledTimes(2)

    // The SECOND request answers first…
    await act(async () => { pending.second(reply([change({ id: 'new', coach_name: 'Coach New', block_date: '2026-09-22' })])) })
    expect((await screen.findByTestId('roster-change-list')).textContent).toMatch(/Coach New/)

    // …and the first one lands late. It is fully flushed before the assertion,
    // so this is not a wait for something to stop happening.
    await act(async () => { pending.first(reply([change({ id: 'old', coach_name: 'Coach Old' })])) })
    const text = screen.getByTestId('roster-change-list').textContent
    expect(text).toMatch(/Coach New/)
    expect(text).not.toMatch(/Coach Old/)
  })

  it('Close sits in the dialog footer, outside the scrolling body, and closes', async () => {
    const onClose = vi.fn()
    global.fetch = answer(200, { success: true, data: { changes: [change()], truncated: false } })
    render(<RosterChangeLogDrawer {...props} onClose={onClose} />)
    const region = await screen.findByRole('region', { name: 'Changes, newest first' })
    const close = within(screen.getByRole('dialog')).getByText('Close')
    // The footer is a sibling of Modal's scrolling body, not inside it.
    expect(region.parentElement.parentElement.contains(close)).toBe(false)
    close.click()
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

// SNAPSHOT.1 — the dialog's second view. Opening it still reads ONE thing
// (the change log); the comparison is read on first switch.
describe('RosterChangeLogDrawer — Published vs now (SNAPSHOT.1)', () => {
  const MISSING = {
    roster: { id: 'r1', status: 'published', period_start: '2026-09-14', period_end: '2026-09-20', published_at: '2026-09-12T13:02:00Z' },
    window: null, baseline: null, missing_reason: 'before_snapshots', snapshots_began_at: null,
    publishes: [], blocks: [], totals: null,
  }
  const byUrl = () => vi.fn(async (url) => ({
    ok: true,
    status: 200,
    json: async () => (String(url).startsWith('/api/schedule/change-log')
      ? { success: true, data: { changes: [], truncated: false } }
      : { success: true, data: MISSING }),
  }))

  it('offers no comparison when nothing in the period is on a published roster', async () => {
    global.fetch = byUrl()
    render(<RosterChangeLogDrawer {...props} />)
    await screen.findByText(/No changes since this was published/)
    expect(screen.queryByRole('button', { name: 'Published vs now' })).toBeNull()
  })

  it('switches to the comparison, which reads each roster for the period; switching back reads nothing again', async () => {
    global.fetch = byUrl()
    render(<RosterChangeLogDrawer {...props} rosterIds={['r1']} />)
    await screen.findByText(/No changes since this was published/)
    expect(global.fetch).toHaveBeenCalledTimes(1)

    const compare = screen.getByRole('button', { name: 'Published vs now' })
    const changesBtn = screen.getByRole('button', { name: 'Changes' })
    expect(changesBtn.getAttribute('aria-pressed')).toBe('true')
    expect(compare.getAttribute('aria-pressed')).toBe('false')

    await act(async () => { compare.click() })
    expect(compare.getAttribute('aria-pressed')).toBe('true')
    await screen.findByTestId('roster-compare-missing')
    expect(global.fetch.mock.calls.map((c) => String(c[0])))
      .toContain('/api/schedule/rosters/r1/compare?from=2026-09-14&to=2026-09-20')

    await act(async () => { changesBtn.click() })
    expect(await screen.findByText(/No changes since this was published/)).toBeTruthy()
    expect(global.fetch.mock.calls.filter((c) => String(c[0]).startsWith('/api/schedule/change-log'))).toHaveLength(1)
  })

  it('the switch buttons are typed buttons, so they can never submit anything', async () => {
    global.fetch = byUrl()
    render(<RosterChangeLogDrawer {...props} rosterIds={['r1']} />)
    await screen.findByText(/No changes since this was published/)
    for (const name of ['Changes', 'Published vs now']) {
      expect(screen.getByRole('button', { name }).getAttribute('type')).toBe('button')
    }
  })
})
