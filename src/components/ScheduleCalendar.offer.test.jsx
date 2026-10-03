// @vitest-environment jsdom
//
// REPLACE.1b — "Offer to team" in the block dialog. The rule and the words
// are pinned in shared/offer-to-team.test.js and OfferToTeamControl.test.jsx;
// this file pins the wiring a pure test cannot reach: the calendar reads the
// period's open offers (manager view), the dialog shows the button on an
// empty published shift and the offer's line when one is open, the button
// posts to the shift, and Withdraw deletes the offer.

import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'

let searchParams = 'view=week&week=2099-05-04&month=2099-05-01'
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
  usePathname: () => '/schedule',
  useSearchParams: () => new URLSearchParams(searchParams),
}))
vi.mock('./RosterSummaryPanel', () => ({ default: () => null }))

import ScheduleCalendar from './ScheduleCalendar.jsx'

vi.setConfig({ testTimeout: 20000 })
const WAIT = { timeout: 5000 }

const LOC = 'loc1'
const manager = { id: 'u1', role: 'manager', activeLocation: { id: LOC, name: 'Studio North' } }

const emptyBlock = () => ({
  id: 'b-1', location_id: LOC, template_id: 't1', block_date: '2099-05-06',
  start_time: '10:00:00', end_time: '12:00:00', min_coaches: 1, max_coaches: 3,
  rosters: { status: 'published' },
  shift_templates: { id: 't1', name: 'Midday Strength', start_time: '10:00:00', end_time: '12:00:00', kind: 'class' },
  shift_assignments: [],
})

const okResponse = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body })

let block
let openOffers
const callsTo = (fragment, method) => global.fetch.mock.calls.filter(([url, init]) => String(url).includes(fragment) && (!method || (init?.method || 'GET') === method))

beforeEach(() => {
  block = emptyBlock()
  openOffers = []
  global.fetch = vi.fn(async (url, init) => {
    const u = String(url)
    if (u.includes('/offer') && init?.method === 'POST') return okResponse({ success: true, data: { offer_id: 'o1', notice: 'now' } }, 201)
    if (u.startsWith('/api/schedule/offers/') && init?.method === 'DELETE') return okResponse({ success: true })
    if (u.startsWith('/api/schedule/offers?')) return okResponse({ success: true, data: openOffers })
    if (u.includes('/schedule/blocks')) return okResponse({ success: true, data: [block] })
    return okResponse({ success: true, data: [] })
  })
  window.confirm = vi.fn(() => true)
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

async function openBlock() {
  render(<ScheduleCalendar user={manager} />)
  fireEvent.click(await screen.findByRole('button', { name: /^Manage 10am Midday Strength shift/ }, WAIT))
  await waitFor(() => expect(screen.getByText('Add coach')).toBeTruthy(), WAIT)
}

describe('REPLACE.1b — Offer to team in the block dialog', () => {
  it('reads the week\'s open offers, manager view', async () => {
    await openBlock()
    const [url] = callsTo('/api/schedule/offers?')[0]
    expect(url).toBe('/api/schedule/offers?location_id=loc1&view=manage&start_date=2099-05-04&end_date=2099-05-10')
  })

  it('an empty published shift offers "Offer to team"; it posts to the shift and says so', async () => {
    await openBlock()
    fireEvent.click(screen.getByRole('button', { name: 'Offer to team' }))
    await screen.findByText('Offered to the team. Coaches who are free are being told now.', {}, WAIT)
    expect(callsTo('/api/schedule/blocks/b-1/offer', 'POST')).toHaveLength(1)
    // The offer line is re-read after the post.
    await waitFor(() => expect(callsTo('/api/schedule/offers?').length).toBeGreaterThanOrEqual(2), WAIT)
  })

  it('a staffed shift shows no offer button', async () => {
    block = { ...emptyBlock(), shift_assignments: [{ id: 'as-a', profile_id: 'c-a', status: 'scheduled', profiles: { full_name: 'Coach A' } }] }
    await openBlock()
    expect(screen.queryByRole('button', { name: 'Offer to team' })).toBeNull()
  })

  it('an open offer shows its line, and Withdraw deletes it', async () => {
    openOffers = [{ id: 'o1', block_id: 'b-1', notice_state: 'morning', broadcast_count: 0 }]
    await openBlock()
    await screen.findByText('Offered to the team · coaches are told from 7am', {}, WAIT)
    expect(screen.queryByRole('button', { name: 'Offer to team' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw offer' }))
    await screen.findByText('Offer withdrawn.', {}, WAIT)
    expect(callsTo('/api/schedule/offers/o1', 'DELETE')).toHaveLength(1)
  })
})
