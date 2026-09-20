// src/components/schedule/RosterChangeLogDrawer.test.jsx
// @vitest-environment jsdom
//
// CHANGELOG.1 — the "Changes since publish" drawer. The sentences are pinned
// in src/lib/roster-change-format.test.js; this is the wiring: what it asks
// for, and what it shows for each answer. jsdom has no layout, so only text,
// roles and presence are asserted. Every findBy waits for something to APPEAR.

import React from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, within } from '@testing-library/react'
import RosterChangeLogDrawer from './RosterChangeLogDrawer.jsx'

const change = (over = {}) => ({
  id: 'c1', action: 'assigned', block_id: 'b1', block_date: '2026-09-15', start_time: '06:00:00', end_time: '07:00:00',
  shift_name: 'Morning', coach_id: 'p1', coach_name: 'Coach A', actor_name: 'Manager B',
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
    expect(items[0].textContent).toMatch(/Assigned Coach A to Tue 15 Sep 06:00/)
    expect(items[0].textContent).toMatch(/told 14:02/)
    expect(items[0].textContent).toMatch(/Manager B · 15 Sep 13:58/)
    expect(items[1].textContent).toMatch(/Removed Coach C from Tue 15 Sep 06:00/)
    expect(items[1].textContent).toMatch(/not told yet/)
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
    global.fetch = vi.fn(async () => { throw new Error('Failed to fetch') })
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
})
