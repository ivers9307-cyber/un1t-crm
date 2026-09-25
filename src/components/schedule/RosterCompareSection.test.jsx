// src/components/schedule/RosterCompareSection.test.jsx
// @vitest-environment jsdom
//
// SNAPSHOT.1 — the Published-vs-now view. The words are pinned in
// src/lib/roster-compare-format.test.js; this is the wiring: what it asks for,
// and what it shows for each answer. jsdom has no layout, so only text, roles
// and presence are asserted (the 390px and scroll checks are browser checks
// in the PR). No fake timers here.

import React from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, within, fireEvent, waitFor } from '@testing-library/react'
import RosterCompareSection from './RosterCompareSection.jsx'

const coachRow = (over = {}) => ({
  profile_id: 'p1', name: 'Coach A', change: 'unchanged',
  published: { start: '06:00', end: '07:00' }, current: { start: '06:00', end: '07:00' },
  arrived_at: null, arrived_local: null, arrival_inferred: false, ended: true, no_show_candidate: false, ...over,
})

const PUB = { snapshot_id: 's1', roster_id: 'r1', published_at: '2026-09-12T13:02:00Z', period_start: '2026-09-14', period_end: '2026-09-20' }

const DATA = {
  roster: { id: 'r1', status: 'published', period_start: '2026-09-14', period_end: '2026-09-20', published_at: PUB.published_at },
  window: { from: '2026-09-14', to: '2026-09-20' },
  baseline: { ...PUB, published_by_name: 'Manager M' },
  missing_reason: null,
  snapshots_began_at: PUB.published_at,
  publishes: [PUB],
  blocks: [
    {
      slot: 't1|2026-09-15', date: '2026-09-15', template_name: 'Morning', kind: 'class', change: 'unchanged', staffing_changed: false,
      published: { start: '06:00', end: '07:00', min: 1, max: 2 }, current: { start: '06:00', end: '07:00', min: 1, max: 2 },
      coaches: [
        coachRow({ change: 'moved', current: { start: '06:30', end: '07:00' }, no_show_candidate: true }),
        coachRow({ profile_id: 'p2', name: 'Coach B', arrived_at: '2026-09-15T04:58:00.000Z', arrived_local: '05:58' }),
      ],
    },
    {
      slot: 't2|2026-09-16', date: '2026-09-16', template_name: 'Evening', kind: 'class', change: 'removed', staffing_changed: false,
      published: { start: '18:00', end: '19:00', min: 1, max: 2 }, current: null,
      coaches: [coachRow({ profile_id: 'p3', name: 'Coach C', change: 'removed', published: { start: '18:00', end: '19:00' }, current: null, ended: false })],
    },
  ],
  totals: {
    published_shifts: 3, published_hours: 3, current_shifts: 2, current_hours: 1.5, hours_delta: -1.5,
    unchanged: 1, moved: 1, added: 0, removed: 1, ended: 2, arrived: 1, arrived_inferred: 0, no_show_candidates: 1,
    blocks_added: 0, blocks_removed: 1, blocks_moved: 0, blocks_staffing_changed: 0,
  },
}

const MISSING = {
  ...DATA, window: null, baseline: null, missing_reason: 'before_snapshots',
  snapshots_began_at: '2026-09-26T08:00:00+00:00', publishes: [], blocks: [], totals: null,
}

const answer = (status, body) => vi.fn(async () => ({ ok: status >= 200 && status < 300, status, json: async () => body }))
const props = { rosterIds: ['r1'], from: '2026-09-14', to: '2026-09-20' }
const urls = () => global.fetch.mock.calls.map((c) => String(c[0]))

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('RosterCompareSection', () => {
  it('asks for each published roster, for the period on screen', async () => {
    global.fetch = answer(200, { success: true, data: DATA })
    render(<RosterCompareSection {...props} rosterIds={['r1', 'r2']} />)
    await screen.findAllByTestId('roster-compare-totals')
    expect(urls().sort()).toEqual([
      '/api/schedule/rosters/r1/compare?from=2026-09-14&to=2026-09-20',
      '/api/schedule/rosters/r2/compare?from=2026-09-14&to=2026-09-20',
    ])
  })

  it('prints the hours, the change counts, and the arrivals with their caveat', async () => {
    global.fetch = answer(200, { success: true, data: DATA })
    render(<RosterCompareSection {...props} />)
    expect((await screen.findByTestId('roster-compare-totals')).textContent).toBe('Published 3.0h · now 1.5h (−1.5h)')
    expect(screen.getByText('1 moved · 1 removed after publish')).toBeTruthy()
    const arrival = screen.getByText(/Arrival recorded for 1 of 2 ended shifts/)
    expect(arrival.textContent).toMatch(/a prompt to check, not a no-show/)
    expect(screen.getByText(/Compared with the publish of Sat 12 Sep, 14:02 by Manager M/)).toBeTruthy()
  })

  it('lists only what changed; unchanged coaches appear when asked', async () => {
    global.fetch = answer(200, { success: true, data: DATA })
    render(<RosterCompareSection {...props} />)
    const list = await screen.findByTestId('roster-compare-list')
    let rows = within(list).getAllByTestId('roster-compare-coach')
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringMatching(/Coach A.*06:00–07:00 → 06:30–07:00.*Moved.*No arrival recorded/),
      expect.stringMatching(/Coach C.*was 18:00–19:00.*Removed after publish/),
    ])
    expect(within(list).getByText('Shift removed after publish')).toBeTruthy()
    expect(screen.queryByText('Coach B')).toBeNull()

    fireEvent.click(screen.getByLabelText('Show unchanged shifts'))
    rows = within(screen.getByTestId('roster-compare-list')).getAllByTestId('roster-compare-coach')
    expect(rows).toHaveLength(3)
    expect(rows.find((r) => r.textContent.includes('Coach B')).textContent).toMatch(/Arrived 05:58/)
  })

  it('a briefing edited after publish shows on its shift, without the text', async () => {
    const briefed = {
      ...DATA,
      blocks: [{ ...DATA.blocks[0], briefing_change: 'changed', coaches: [coachRow({ arrived_local: '05:58', arrived_at: 'x' })] }],
    }
    global.fetch = answer(200, { success: true, data: briefed })
    render(<RosterCompareSection {...props} />)
    const list = await screen.findByTestId('roster-compare-list')
    expect(within(list).getByText('Briefing changed after publish')).toBeTruthy()
    expect(screen.queryByText('Every shift is as it was published.')).toBeNull()
  })

  it('a week exactly as published says so', async () => {
    const quiet = { ...DATA, blocks: [{ ...DATA.blocks[0], coaches: [coachRow({ arrived_local: '05:58', arrived_at: 'x' })] }] }
    global.fetch = answer(200, { success: true, data: quiet })
    render(<RosterCompareSection {...props} />)
    expect(await screen.findByText('Every shift is as it was published.')).toBeTruthy()
  })

  it('a roster with no snapshot says why, and is not an error', async () => {
    global.fetch = answer(200, { success: true, data: MISSING })
    render(<RosterCompareSection {...props} />)
    expect((await screen.findByTestId('roster-compare-missing')).textContent)
      .toBe('Published vs now is available for rosters published from Sat 26 Sep. This roster was published before then.')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByTestId('roster-compare-totals')).toBeNull()
  })

  it('a failed read is an ERROR, never "every shift is as it was published"', async () => {
    global.fetch = answer(500, { success: false, error: 'The comparison could not be read' })
    render(<RosterCompareSection {...props} />)
    expect((await screen.findByRole('alert')).textContent).toMatch(/could not be read/)
    expect(screen.queryByText('Every shift is as it was published.')).toBeNull()
  })

  it('a dropped connection is an error in words an operator can read', async () => {
    global.fetch = vi.fn(async () => { throw new TypeError('Failed to fetch') })
    render(<RosterCompareSection {...props} />)
    expect((await screen.findByRole('alert')).textContent).toBe('Network error, could not load the comparison.')
  })

  it('with several publishes of the period, choosing another re-reads against it', async () => {
    const earlier = { ...PUB, snapshot_id: 's0', roster_id: 'r0', published_at: '2026-09-10T08:00:00Z' }
    global.fetch = answer(200, { success: true, data: { ...DATA, publishes: [PUB, earlier] } })
    render(<RosterCompareSection {...props} />)
    const select = await screen.findByLabelText('Compare with')
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Sat 12 Sep, 14:02 · Mon 14 Sep – Sun 20 Sep (this roster)',
      'Thu 10 Sep, 09:00 · Mon 14 Sep – Sun 20 Sep',
    ])
    fireEvent.change(select, { target: { value: 's0' } })
    await waitFor(() => expect(urls()).toContain('/api/schedule/rosters/r1/compare?from=2026-09-14&to=2026-09-20&against=s0'))
  })

  it('offers no choice when there is only one publish', async () => {
    global.fetch = answer(200, { success: true, data: DATA })
    render(<RosterCompareSection {...props} />)
    await screen.findByTestId('roster-compare-totals')
    expect(screen.queryByLabelText('Compare with')).toBeNull()
  })

  it('nothing in the period is published: says so and reads nothing', () => {
    global.fetch = vi.fn()
    render(<RosterCompareSection {...props} rosterIds={[]} />)
    expect(screen.getByText(/Nothing in this period is on a published roster/)).toBeTruthy()
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('reads at most four rosters, and says so', async () => {
    global.fetch = answer(200, { success: true, data: DATA })
    render(<RosterCompareSection {...props} rosterIds={['a', 'b', 'c', 'd', 'e']} />)
    await screen.findAllByTestId('roster-compare-totals')
    expect(global.fetch).toHaveBeenCalledTimes(4)
    expect(screen.getByText(/Showing the first 4 of 5 rosters/)).toBeTruthy()
  })
})
