// @vitest-environment jsdom
//
// ROSTERVIS.1 — the calendar says when a shift is below its minimum (not only
// when it is empty), the week banner and the publish preview count those, and
// the header says whether the period on screen is published.
//
// The derivations are pinned in src/lib/roster-staffing.test.js; this file is
// the wiring. jsdom has no layout (memory `jsdom-cannot-see-layout`), so only
// text, roles and presence are asserted here.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent, act, waitFor, within } from '@testing-library/react'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace() {} }),
  usePathname: () => '/schedule',
  useSearchParams: () => new URLSearchParams(),
}))

import ScheduleCalendar from '@/components/ScheduleCalendar'

// The publish-preview test waits up to 5s for the modal's dry run; the file's
// budget must sit above that or the wait is never honoured under load
// (tests/test-timeout-budgets.test.js).
vi.setConfig({ testTimeout: 20000 })

function iso(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function isoMonday() {
  const d = new Date()
  const day = d.getDay()
  d.setDate(d.getDate() - day + (day === 0 ? -6 : 1))
  return iso(d)
}
// Today or later, inside the rendered week, so every fixture is future demand.
const BLOCK_DATE = isoMonday() > iso(new Date()) ? isoMonday() : iso(new Date())

const TEMPLATE = { id: 't1', name: 'Morning', start_time: '09:00', end_time: '12:00', color: '#3B82F6', active: true, max_coaches: 3 }
const PUBLISHED = { id: 'r1', status: 'published' }

const liveAssignment = (id, name) => ({ id, profile_id: id, status: 'confirmed', profiles: { full_name: name } })

function mkBlock(over) {
  return {
    location_id: 'loc1', block_date: BLOCK_DATE, template_id: 't1',
    start_time: '09:00', end_time: '12:00', max_coaches: 3, min_coaches: 1,
    shift_templates: TEMPLATE, shift_assignments: [], rosters: null, ...over,
  }
}

const SHORT_BLOCK = mkBlock({
  id: 'short', min_coaches: 2, rosters: PUBLISHED,
  shift_templates: { ...TEMPLATE, name: 'Early' },
  // One live coach plus a cancelled row, which must not count.
  shift_assignments: [liveAssignment('u2', 'Sarah Doyle'), { id: 'x', profile_id: 'u3', status: 'cancelled', profiles: { full_name: 'Mike Byrne' } }],
})
const EMPTY_BLOCK = mkBlock({ id: 'empty', start_time: '17:00', end_time: '18:00', shift_templates: { ...TEMPLATE, name: 'Consultation' } })
const OK_BLOCK = mkBlock({
  id: 'ok', start_time: '12:00', end_time: '13:00', min_coaches: 1, rosters: PUBLISHED,
  shift_templates: { ...TEMPLATE, name: 'Lunch' }, shift_assignments: [liveAssignment('u3', 'Mike Byrne')],
})

const STAFF = [
  { id: 'u1', full_name: 'Colm Manager', role: 'manager', active: true, profile_locations: [{ location_id: 'loc1' }] },
  { id: 'u2', full_name: 'Sarah Doyle', role: 'coach', active: true, profile_locations: [{ location_id: 'loc1' }] },
  { id: 'u3', full_name: 'Mike Byrne', role: 'coach', active: true, profile_locations: [{ location_id: 'loc1' }] },
]
const MANAGER = { id: 'u1', role: 'manager', activeLocation: { id: 'loc1', name: 'Stillorgan' } }
const COACH = { id: 'u2', role: 'coach', activeLocation: { id: 'loc1', name: 'Stillorgan' } }

function mockFetch({ blocks, drafts = [], impact = null }) {
  return vi.fn((url, opts) => {
    const u = String(url)
    let body
    if (u.includes('/api/schedule/blocks')) body = { success: true, data: blocks }
    else if (u.includes('/api/schedule/templates')) body = { success: true, data: [TEMPLATE] }
    else if (u.includes('/api/staff')) body = { success: true, data: STAFF }
    else if (u.includes('/api/schedule/time-off')) body = { success: true, data: [] }
    else if (u.includes('/holidays')) body = { success: true, data: [] }
    else if (u.includes('contractor-spend')) body = { success: true, data: null }
    else if (u.includes('/api/schedule/week-cost')) body = { success: true, data: null }
    else if (u.includes('/api/schedule/rosters') && (!opts || opts.method !== 'POST')) body = { success: true, data: drafts }
    else body = { success: true, impact }
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) })
  })
}

async function renderCalendar({ user = MANAGER, ...fetchOpts }) {
  global.fetch = mockFetch(fetchOpts)
  await act(async () => { render(<ScheduleCalendar user={user} />) })
  await waitFor(() => expect(screen.queryByText(/Loading roster/)).toBeNull())
}

beforeEach(() => { vi.stubGlobal('confirm', () => true) })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('below-minimum shifts (ROSTERVIS.1)', () => {
  it('a manager sees "1 of 2" on a short card, counting live coaches only', async () => {
    await renderCalendar({ blocks: [SHORT_BLOCK, EMPTY_BLOCK, OK_BLOCK] })
    const badges = screen.getAllByTestId('short-staffed-badge')
    expect(badges).toHaveLength(1)
    expect(badges[0].textContent).toMatch(/1 of 2/)
    expect(badges[0].textContent).toMatch(/Below minimum/)
    // The empty card keeps its own red treatment.
    expect(screen.getByText('Unstaffed — assign a coach')).toBeTruthy()
  })

  it('the week banner counts short shifts as well as empty ones', async () => {
    await renderCalendar({ blocks: [SHORT_BLOCK, EMPTY_BLOCK, OK_BLOCK] })
    const banner = screen.getByTestId('staffing-gaps-banner')
    expect(banner.textContent).toMatch(/2 shifts need coaches this week/)
    expect(banner.textContent).toMatch(/1 with no coach, 1 below the minimum/)
  })

  it('a week whose only gap is a short shift still raises the banner', async () => {
    await renderCalendar({ blocks: [SHORT_BLOCK, OK_BLOCK] })
    expect(screen.getByTestId('staffing-gaps-banner').textContent).toMatch(/1 shift needs coaches this week/)
  })

  it('a coach sees no badge, no banner and no publication chip', async () => {
    await renderCalendar({ user: COACH, blocks: [SHORT_BLOCK, OK_BLOCK] })
    expect(screen.queryByTestId('short-staffed-badge')).toBeNull()
    expect(screen.queryByTestId('staffing-gaps-banner')).toBeNull()
    expect(screen.queryByTestId('publication-status')).toBeNull()
  })
})

describe('publication status chip (ROSTERVIS.1)', () => {
  it('Published when every block in the week is on a published roster', async () => {
    await renderCalendar({ blocks: [SHORT_BLOCK, OK_BLOCK] })
    expect(screen.getByTestId('publication-status').textContent).toMatch(/Week status: Published$/)
  })

  it('Partly published on a mix', async () => {
    await renderCalendar({ blocks: [SHORT_BLOCK, EMPTY_BLOCK, OK_BLOCK] })
    expect(screen.getByTestId('publication-status').textContent).toMatch(/Partly published \(2 of 3 shifts\)/)
  })

  it('Not published when nothing is', async () => {
    await renderCalendar({ blocks: [EMPTY_BLOCK] })
    expect(screen.getByTestId('publication-status').textContent).toMatch(/Not published/)
  })

  it('Draft (awaiting approval) when a draft roster covers the week', async () => {
    await renderCalendar({
      blocks: [EMPTY_BLOCK],
      drafts: [{ id: 'd1', status: 'draft', period_start: isoMonday(), period_end: BLOCK_DATE }],
    })
    await waitFor(() => expect(screen.getByTestId('publication-status').textContent).toMatch(/Draft \(awaiting approval\)/))
  })

  it('month view reports the month', async () => {
    // The Month toggle picks the month of the week's THURSDAY (monthStartForWeek),
    // so date the block there: on a week straddling a month end, a block on
    // Monday would fall outside the month shown. Past or future does not matter
    // to publication.
    const thu = new Date(`${isoMonday()}T00:00:00`)
    thu.setDate(thu.getDate() + 3)
    await renderCalendar({ blocks: [{ ...OK_BLOCK, block_date: iso(thu) }] })
    fireEvent.click(screen.getByText('Month'))
    await waitFor(() => expect(screen.queryByText(/Loading roster/)).toBeNull())
    expect(screen.getByTestId('publication-status').textContent).toMatch(/Month status: Published/)
  })
})

describe('publish preview staffing list (ROSTERVIS.1)', () => {
  it('lists empty and short shifts above the cost figures, and still offers Publish', async () => {
    await renderCalendar({
      blocks: [SHORT_BLOCK, EMPTY_BLOCK],
      impact: {
        blockCount: 2, periodProjectedEur: 0, monthProjectedTotalEur: 0, monthlyBudgetEur: 100, overBudget: false,
        staffingGaps: [
          { block_id: 'short', block_date: BLOCK_DATE, start_time: '09:00', end_time: '12:00', name: 'Early', status: 'short', count: 1, min: 2 },
          { block_id: 'empty', block_date: BLOCK_DATE, start_time: '17:00', end_time: '18:00', name: 'Consultation', status: 'empty', count: 0, min: 1 },
        ],
      },
    })
    fireEvent.click(screen.getByText('Publish'))
    const list = await screen.findByTestId('publish-staffing-gaps', {}, { timeout: 5000 })
    expect(list.textContent).toMatch(/2 shifts need coaches in this period/)
    expect(within(list).getByText('1 of 2')).toBeTruthy()
    expect(within(list).getByText('No coach')).toBeTruthy()
    expect(list.textContent).toMatch(/Early/)
    expect(list.textContent).toMatch(/Consultation/)
    // Above the cost tiles, in document order.
    const tiles = screen.getByText('Blocks in period')
    expect(list.compareDocumentPosition(tiles) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // Information only: the confirm button is there and enabled.
    const publishButtons = screen.getAllByRole('button', { name: 'Publish' })
    expect(publishButtons[publishButtons.length - 1].disabled).toBe(false)
  })
})
