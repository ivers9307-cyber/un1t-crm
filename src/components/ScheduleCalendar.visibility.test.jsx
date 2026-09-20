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

// CHANGELOG.1 — what the drawer's read answers. Reassigned per test.
let CHANGES = []

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
    else if (u.includes('/api/schedule/change-log')) body = { success: true, data: { changes: CHANGES, truncated: false } }
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
    // ROSTERLOOK.1 — the empty card says "Needs coach" and is the only one
    // flagged empty; the staffed card is flagged nothing.
    expect(screen.getAllByTestId('needs-coach-badge')).toHaveLength(1)
    const statuses = screen.getAllByTestId('shift-card').map((c) => c.getAttribute('data-status')).sort()
    expect(statuses).toEqual(['empty', 'ok', 'short'])
  })

  it('no card carries a capacity chip, and every card is neutral (ROSTERLOOK.1)', async () => {
    await renderCalendar({ blocks: [SHORT_BLOCK, EMPTY_BLOCK, OK_BLOCK] })
    for (const card of screen.getAllByTestId('shift-card')) {
      expect(card.textContent).not.toMatch(/\d+\s*\/\s*\d+/)   // was "1/3" on every card
      expect(card.getAttribute('data-tone')).toBe('neutral')
      expect(card.getAttribute('style')).toBeNull()             // was the template colour at 12%
    }
  })

  it('a card reads time, then coach, then template (ROSTERLOOK.1)', async () => {
    await renderCalendar({ blocks: [OK_BLOCK] })
    const card = screen.getByTestId('shift-card')
    expect(within(card).getByTestId('shift-time').textContent).toBe('12–1pm')
    expect(within(card).getByText('Mike Byrne')).toBeTruthy()
    expect(within(card).getByTestId('shift-template').textContent).toBe('Lunch')
  })

  it('a coach sees the same cards with no status on them (ROSTERLOOK.1)', async () => {
    await renderCalendar({ user: COACH, blocks: [SHORT_BLOCK, OK_BLOCK] })
    const cards = screen.getAllByTestId('shift-card')
    expect(cards).toHaveLength(2)
    for (const card of cards) {
      expect(card.getAttribute('data-status')).toBe('ok')
      expect(card.textContent).not.toMatch(/\d+ of \d+|\d+\s*\/\s*\d+/)
      // The tooltip is built from the same model, so it is inside the boundary.
      expect(card.getAttribute('title')).not.toMatch(/minimum|Needs coach|\d+ of \d+/)
    }
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

describe('publish preview clashes (COPYLEAVE.1)', () => {
  const BASE = { blockCount: 2, periodProjectedEur: 0, monthProjectedTotalEur: 0, monthlyBudgetEur: 100, overBudget: false, staffingGaps: [] }
  const LEAVE_CLASH = {
    block_id: 'short', block_date: BLOCK_DATE, start_time: '09:00', end_time: '12:00', name: 'Early',
    profile_id: 'u2', coach_name: 'Coach A', leave_start: BLOCK_DATE, leave_end: BLOCK_DATE,
  }
  const DOUBLE = {
    profile_id: 'u3', coach_name: 'Coach B', block_date: BLOCK_DATE,
    first: { block_id: 'ok', name: 'Lunch', start_time: '12:00', end_time: '13:00', location_name: null },
    second: { block_id: 'ob1', name: 'Open Gym', start_time: '12:30', end_time: '14:00', location_name: 'Studio B' },
  }

  async function openPreview(impact) {
    await renderCalendar({ blocks: [SHORT_BLOCK, OK_BLOCK], impact })
    fireEvent.click(screen.getByText('Publish'))
    await screen.findByText('Blocks in period', {}, { timeout: 5000 })
  }

  it('names the coach on leave and the double-booked coach, with times and the other studio', async () => {
    await openPreview({ ...BASE, leaveClashes: [LEAVE_CLASH], doubleBookings: [DOUBLE], crossLocationChecked: true })
    const box = screen.getByTestId('publish-roster-clashes')
    expect(box.textContent).toMatch(/1 coach rostered on approved leave/)
    expect(box.textContent).toMatch(/Coach A/)
    expect(box.textContent).toMatch(/9am Early/)
    expect(box.textContent).toMatch(/1 double booking/)
    expect(box.textContent).toMatch(/Coach B/)
    expect(box.textContent).toMatch(/12pm–1pm Lunch/)
    expect(box.textContent).toMatch(/12:30pm–2pm Open Gym \(Studio B\)/)
    // Never money.
    expect(box.textContent).not.toMatch(/€/)
    // Information only: Publish is still there and enabled.
    const publishButtons = screen.getAllByRole('button', { name: 'Publish' })
    expect(publishButtons[publishButtons.length - 1].disabled).toBe(false)
  })

  // Quality review — one coach off all week and rostered twice is ONE coach.
  it('counts coaches, not shifts, in the leave headline, and still lists each shift', async () => {
    const second = { ...LEAVE_CLASH, block_id: 'ok', start_time: '12:00', end_time: '13:00', name: 'Lunch' }
    await openPreview({ ...BASE, leaveClashes: [LEAVE_CLASH, second], doubleBookings: [], crossLocationChecked: true })
    const box = screen.getByTestId('publish-roster-clashes')
    expect(box.textContent).toMatch(/1 coach rostered on approved leave/)
    expect(box.textContent).not.toMatch(/2 coach/)
    expect(box.textContent).toMatch(/9am Early/)
    expect(box.textContent).toMatch(/12pm Lunch/)
  })

  // Quality review — the leave range is shown on each line. Expected strings
  // are built with the modal's own day format so the ICU month spelling
  // ("Sep" / "Sept") can never be what fails this.
  it('shows the leave range on each leave line: one day, or first to last', async () => {
    const day = (d) => new Date(`${d}T00:00:00`).toLocaleDateString('en-IE', { day: 'numeric', month: 'short' })
    const end = iso(new Date(new Date(`${BLOCK_DATE}T00:00:00`).getFullYear() + 1, 0, 15)) // next year: never the same month
    const ranged = { ...LEAVE_CLASH, block_id: 'ok', profile_id: 'u3', coach_name: 'Coach B', leave_end: end }
    await openPreview({ ...BASE, leaveClashes: [LEAVE_CLASH, ranged], doubleBookings: [], crossLocationChecked: true })
    const lines = within(screen.getByTestId('publish-roster-clashes')).getAllByRole('listitem').map((li) => li.textContent)
    expect(lines[0]).toContain(`on leave ${day(BLOCK_DATE)}`)
    expect(lines[0]).not.toContain(' to ')
    expect(lines[1]).toContain(`on leave ${day(BLOCK_DATE)} to ${day(end)}`)
  })

  it('sits beside the staffing list, above the cost tiles', async () => {
    await openPreview({ ...BASE, leaveClashes: [LEAVE_CLASH], doubleBookings: [], crossLocationChecked: true })
    const box = screen.getByTestId('publish-roster-clashes')
    const tiles = screen.getByText('Blocks in period')
    expect(box.compareDocumentPosition(tiles) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('renders nothing when there is nothing to say', async () => {
    await openPreview({ ...BASE, leaveClashes: [], doubleBookings: [], crossLocationChecked: true })
    expect(screen.queryByTestId('publish-roster-clashes')).toBeNull()
  })

  it('renders nothing for an older server that does not send the lists', async () => {
    await openPreview(BASE)
    expect(screen.queryByTestId('publish-roster-clashes')).toBeNull()
  })

  // crossLocationChecked: false also covers a helper that threw, so the line
  // must not blame other studios specifically.
  it('says so when a check could not be completed, rather than implying an all-clear', async () => {
    await openPreview({ ...BASE, leaveClashes: [], doubleBookings: [], crossLocationChecked: false })
    const text = screen.getByTestId('publish-roster-clashes').textContent
    expect(text).toMatch(/Some clash checks could not be completed\./)
    expect(text).not.toMatch(/other studios/)
  })
})

describe('changes since publish (CHANGELOG.1)', () => {
  const changeLogCalls = () => global.fetch.mock.calls.map(([u]) => String(u)).filter((u) => u.includes('/api/schedule/change-log'))

  beforeEach(() => { CHANGES = [] })

  it('the Published chip is a button that opens the drawer for the week on screen', async () => {
    CHANGES = [{
      id: 'c1', action: 'assigned', block_date: BLOCK_DATE, start_time: '12:00:00', end_time: '13:00:00',
      shift_name: 'Lunch', coach_name: 'Coach A', actor_name: 'Manager B', self_change: false,
      details: {}, notified_at: null, created_at: `${BLOCK_DATE}T10:00:00.000+00:00`,
    }]
    await renderCalendar({ blocks: [SHORT_BLOCK, OK_BLOCK] })
    const chip = screen.getByTestId('publication-status')
    expect(chip.tagName).toBe('BUTTON')
    expect(chip.getAttribute('type')).toBe('button')
    // Nothing is fetched until it is asked for.
    expect(changeLogCalls()).toHaveLength(0)

    fireEvent.click(chip)
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Changes since publish')).toBeTruthy()
    expect(await within(dialog).findByText(/Assigned Coach A to/)).toBeTruthy()

    const sunday = new Date(`${isoMonday()}T00:00:00`)
    sunday.setDate(sunday.getDate() + 6)
    expect(changeLogCalls()).toEqual([`/api/schedule/change-log?location_id=loc1&from=${isoMonday()}&to=${iso(sunday)}`])
  })

  it('a partly published week opens it too', async () => {
    await renderCalendar({ blocks: [SHORT_BLOCK, EMPTY_BLOCK, OK_BLOCK] })
    expect(screen.getByTestId('publication-status').tagName).toBe('BUTTON')
  })

  it('an unpublished week has nothing to show: the chip stays plain text', async () => {
    await renderCalendar({ blocks: [EMPTY_BLOCK] })
    expect(screen.getByTestId('publication-status').tagName).toBe('SPAN')
  })

  it('closing the drawer returns to the calendar', async () => {
    await renderCalendar({ blocks: [SHORT_BLOCK, OK_BLOCK] })
    fireEvent.click(screen.getByTestId('publication-status'))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByText('Close'))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('focus goes back to the chip when the drawer closes, even when the click never focused it', async () => {
    // Safari and Firefox on macOS do not focus a button on click, so Modal
    // captures <body> as "where focus came from". fireEvent.click behaves the
    // same way, which makes this the honest case: the chip is NOT pre-focused.
    await renderCalendar({ blocks: [SHORT_BLOCK, OK_BLOCK] })
    const chip = screen.getByTestId('publication-status')
    expect(document.activeElement).not.toBe(chip)
    fireEvent.click(chip)
    const dialog = await screen.findByRole('dialog')
    expect(dialog.contains(document.activeElement)).toBe(true)
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(document.activeElement).toBe(screen.getByTestId('publication-status'))
  })

  it('the button is named for what it opens, not only for the status', async () => {
    await renderCalendar({ blocks: [SHORT_BLOCK, OK_BLOCK] })
    expect(screen.getByRole('button', { name: 'Published. View changes since publish' }))
      .toBe(screen.getByTestId('publication-status'))
  })

  it('a partly published week names its count too', async () => {
    await renderCalendar({ blocks: [SHORT_BLOCK, EMPTY_BLOCK, OK_BLOCK] })
    expect(screen.getByRole('button', { name: 'Partly published (2 of 3 shifts). View changes since publish' })).toBeTruthy()
  })

  it('the live region stays mounted while the week changes, so the new status is announced', async () => {
    // A role=status node that is inserted ALREADY populated is often skipped
    // by screen readers. The wrapper must be the same node before, during and
    // after a load; only its contents change.
    await renderCalendar({ blocks: [SHORT_BLOCK, OK_BLOCK] })
    const region = screen.getByTestId('publication-status').closest('[role="status"]')
    fireEvent.click(screen.getByLabelText('Next week'))
    await waitFor(() => expect(screen.queryByText(/Loading roster/)).toBeNull())
    expect(region.isConnected).toBe(true)
    fireEvent.click(screen.getByLabelText('Previous week'))
    const chip = await screen.findByTestId('publication-status')
    expect(chip.closest('[role="status"]')).toBe(region)
  })

  it('the status is still a live region, and the button says what it opens', async () => {
    await renderCalendar({ blocks: [SHORT_BLOCK, OK_BLOCK] })
    const chip = screen.getByTestId('publication-status')
    expect(chip.closest('[role="status"]')).toBeTruthy()
    expect(chip.getAttribute('role')).toBeNull()
    expect(chip.getAttribute('aria-haspopup')).toBe('dialog')
    expect(chip.getAttribute('title')).toBe('See changes since publish')
  })

  it('a coach has no chip, so no way in', async () => {
    await renderCalendar({ user: COACH, blocks: [SHORT_BLOCK, OK_BLOCK] })
    expect(screen.queryByTestId('publication-status')).toBeNull()
  })
})

describe('day headers carry the staffing status (ROSTERLOOK.1)', () => {
  const longDay = new Date(`${BLOCK_DATE}T00:00:00`).toLocaleDateString('en-IE', { weekday: 'long', day: 'numeric', month: 'long' })

  it('a manager sees one status per day with future shifts, in words as well as colour', async () => {
    await renderCalendar({ blocks: [SHORT_BLOCK, EMPTY_BLOCK, OK_BLOCK] })
    const dots = screen.getAllByTestId('status-dot')
    expect(dots).toHaveLength(1) // every fixture sits on BLOCK_DATE
    expect(dots[0].getAttribute('data-tone')).toBe('empty')
    expect(dots[0].textContent).toMatch(/2 short/)
    expect(dots[0].textContent).toMatch(/2 shifts need coaches: 1 with no coach, 1 below the minimum/)
  })

  it('without somewhere to open, the header is not a button (the calendar rendered alone)', async () => {
    await renderCalendar({ blocks: [OK_BLOCK] })
    expect(screen.queryByRole('button', { name: /Open studio overview/ })).toBeNull()
    expect(screen.getAllByTestId('day-header')).toHaveLength(7)
  })

  it('given onOpenDayOverview, the header reports its own date', async () => {
    const onOpenDayOverview = vi.fn()
    global.fetch = mockFetch({ blocks: [OK_BLOCK] })
    await act(async () => { render(<ScheduleCalendar user={MANAGER} onOpenDayOverview={onOpenDayOverview} />) })
    await waitFor(() => expect(screen.queryByText(/Loading roster/)).toBeNull())
    const header = screen.getByRole('button', { name: new RegExp(`^${longDay}\\.`) })
    fireEvent.click(header)
    // The date, and the header element itself: the dialog's owner needs the
    // opener to give focus back to (Safari never focuses a clicked button).
    expect(onOpenDayOverview).toHaveBeenCalledWith(BLOCK_DATE, header)
  })

  it('a coach sees no status and no clickable header, even when handed the prop', async () => {
    global.fetch = mockFetch({ blocks: [SHORT_BLOCK, OK_BLOCK] })
    await act(async () => { render(<ScheduleCalendar user={COACH} onOpenDayOverview={() => {}} />) })
    await waitFor(() => expect(screen.queryByText(/Loading roster/)).toBeNull())
    expect(screen.queryByTestId('status-dot')).toBeNull()
    expect(screen.queryByRole('button', { name: /Open studio overview/ })).toBeNull()
  })
})

describe('month view names the coaches (ROSTERLOOK.1)', () => {
  async function renderMonth(opts) {
    await renderCalendar(opts)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Month' })) })
    await waitFor(() => expect(screen.queryByText(/Loading roster/)).toBeNull())
  }

  it('a manager reads time + first names, numbers only on the short line, and no "!1" / "↓1"', async () => {
    await renderMonth({ blocks: [SHORT_BLOCK, EMPTY_BLOCK, OK_BLOCK] })
    const lines = screen.getAllByTestId('month-line').map((n) => n.textContent)
    expect(lines).toEqual(['9 Sarah (1 of 2)', '12pm Mike', '5pm Needs coach'])
    expect(document.body.textContent).not.toMatch(/[!↓]\d/)
    expect(document.body.textContent).not.toMatch(/\d+\/\d+/) // the old "1/3"
    const dot = screen.getByTestId('status-dot')
    expect(dot.getAttribute('title')).toBe('2 shifts need coaches: 1 with no coach, 1 below the minimum')
  })

  it('a coach reads the same names with no status, no numbers and no dot', async () => {
    await renderMonth({ user: COACH, blocks: [SHORT_BLOCK, OK_BLOCK] })
    // The fixture hands the coach a short block WITH min_coaches, which the
    // real feed never does: the guarantee under test is the model's.
    expect(screen.queryByTestId('status-dot')).toBeNull()
    for (const line of screen.getAllByTestId('month-line')) {
      expect(['ok', 'quiet']).toContain(line.getAttribute('data-tone'))
      expect(line.textContent).not.toMatch(/\d+ of \d+|Needs coach/)
      expect(line.getAttribute('title')).not.toMatch(/minimum|\d+ of \d+/)
    }
  })
})

// 🔴 NOT proof. The defect was measured in a browser: at 390px the document was
// 777px wide, because sr-only spans (position:absolute) inside the 7-column
// grid had no positioned ancestor inside the grid's own scroller, so the
// scroller did not clip them. The proof is, at 390 wide:
//   document.documentElement.scrollWidth <= document.documentElement.clientWidth
// This pins the classes that make that true so they are not dropped again.
describe('the roster scrolls inside its own container, not the page (ROSTERLOOK.1)', () => {
  const POSITIONED = /(^|\s)(relative|absolute|fixed|sticky)(\s|$)/

  it('week view: the scroller is a containing block, and no sr-only span escapes it', async () => {
    await renderCalendar({ blocks: [SHORT_BLOCK, EMPTY_BLOCK, OK_BLOCK] })
    const scroller = screen.getAllByTestId('day-header')[0].closest('.overflow-x-auto')
    expect(scroller.className).toMatch(/\brelative\b/)
    const hidden = scroller.querySelectorAll('.sr-only')
    expect(hidden.length).toBeGreaterThan(0)
    for (const el of hidden) expect(el.parentElement.className, el.parentElement.outerHTML.slice(0, 120)).toMatch(POSITIONED)
  })

  it('month view: the same', async () => {
    await renderCalendar({ blocks: [SHORT_BLOCK, EMPTY_BLOCK, OK_BLOCK] })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Month' })) })
    await waitFor(() => expect(screen.queryByText(/Loading roster/)).toBeNull())
    const scroller = screen.getAllByTestId('month-line')[0].closest('.overflow-x-auto')
    expect(scroller.className).toMatch(/\brelative\b/)
    const hidden = scroller.querySelectorAll('.sr-only')
    expect(hidden.length).toBeGreaterThan(0)
    for (const el of hidden) expect(el.parentElement.className, el.parentElement.outerHTML.slice(0, 120)).toMatch(POSITIONED)
  })
})
