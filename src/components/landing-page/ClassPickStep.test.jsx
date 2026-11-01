// @vitest-environment jsdom
//
// CLASSFIRST.1 — ClassPickStep: the date tiles shared by /50plus, /trial and
// /corp. The parent holds the list (useClassList) so a step change never
// refetches; the step shows the tiles, the empty states in the operator's
// words, the class name when asked, and the skip button only on an empty or
// unreadable list and only when the parent allows it.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, renderHook, waitFor } from '@testing-library/react'
import ClassPickStep, { useClassList, cadenceGroups, ctaLabelFor, campaignFunnelClassesUrl, isDayFirst } from './ClassPickStep'

const COPY = { not_configured_text: 'Not open', timetable_unavailable_text: 'Try later', no_classes_text: 'Nothing open', skip_class_label: 'Carry on without a class' }
const CLASSES = [
  { event_id: 'a', name: 'S&C', starts_at: '2099-01-05T11:00:00.000Z', day: '2099-01-05', day_label: 'Mon, 5 Jan', time: '11:00' },
  { event_id: 'b', name: 'RALLY', starts_at: '2099-01-06T18:00:00.000Z', day: '2099-01-06', day_label: 'Tue, 6 Jan', time: '18:00' },
  { event_id: 'c', name: 'S&C', starts_at: '2099-01-07T11:00:00.000Z', day: '2099-01-07', day_label: 'Wed, 7 Jan', time: '11:00' },
  { event_id: 'd', name: 'S&C', starts_at: '2099-01-09T11:00:00.000Z', day: '2099-01-09', day_label: 'Fri, 9 Jan', time: '11:00' },
]
const loaded = (classes, extra = {}) => ({ classes, loading: false, configured: true, unavailable: false, ...extra })
const mount = (props) => render(<ClassPickStep list={loaded(CLASSES)} copy={COPY} chosen={null} onPick={() => {}} onContinue={() => {}} ctaLabel="Next" title="Pick" body="B" {...props} />)

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('ClassPickStep', () => {
  it('renders a typed tile per slot in day order, the class name only when asked, and More dates for the second row', () => {
    mount()
    const tiles = screen.getAllByRole('button', { pressed: false })
    expect(tiles.map((t) => t.getAttribute('data-tile'))).toEqual(['a', 'b', 'c', 'd'])
    for (const t of tiles) expect(t.getAttribute('type')).toBe('button')
    expect(screen.queryByText('S&C')).toBeNull()
    expect(screen.getByRole('button', { name: 'More dates (1)' })).toBeTruthy()
    cleanup()
    mount({ showClassName: true })
    expect(screen.getAllByText('S&C')).toHaveLength(3)
    expect(screen.getByText('RALLY')).toBeTruthy()
  })

  it('the continue button is disabled until a class is chosen, and picking reports the slot', () => {
    const onPick = vi.fn()
    const onContinue = vi.fn()
    mount({ onPick, onContinue })
    const next = screen.getByRole('button', { name: 'Next' })
    expect(next.disabled).toBe(true)
    fireEvent.click(screen.getAllByRole('button', { pressed: false })[1])
    expect(onPick).toHaveBeenCalledWith(CLASSES[1])
    cleanup()
    mount({ onPick, onContinue, chosen: CLASSES[1] })
    const chosenTile = screen.getByRole('button', { pressed: true })
    expect(chosenTile.getAttribute('data-tile')).toBe('b')
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(onContinue).toHaveBeenCalledTimes(1)
  })

  it('the empty states speak the operator words; the skip button shows only on empty or unavailable, only with onSkip', () => {
    const onSkip = vi.fn()
    mount({ list: loaded([]), onSkip })
    expect(screen.getByRole('status').textContent).toBe('Nothing open')
    const skip = screen.getByRole('button', { name: 'Carry on without a class' })
    expect(skip.getAttribute('type')).toBe('button')
    fireEvent.click(skip)
    expect(onSkip).toHaveBeenCalledTimes(1)
    cleanup()
    mount({ list: loaded([], { unavailable: true }), onSkip })
    expect(screen.getByRole('status').textContent).toBe('Try later')
    expect(screen.getByRole('button', { name: 'Carry on without a class' })).toBeTruthy()
    cleanup()
    mount({ list: loaded([], { configured: false }), onSkip })
    expect(screen.getByRole('status').textContent).toBe('Not open')
    expect(screen.queryByRole('button', { name: 'Carry on without a class' })).toBeNull()
    cleanup()
    mount({ list: loaded([]) })
    expect(screen.queryByRole('button')).toBeNull()
    cleanup()
    mount({ list: loaded(CLASSES), onSkip })
    expect(screen.queryByRole('button', { name: 'Carry on without a class' })).toBeNull()
  })

  it('loading shows the timetable check and no buttons', () => {
    mount({ list: { classes: [], loading: true, configured: true, unavailable: false } })
    expect(screen.getByText('Checking the timetable…')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })
})

// CLASSFIRST.2 — a busy studio: more than one slot a day is day-first.
const BUSY = [
  { event_id: 'm6', name: 'FORCE.', starts_at: '2099-01-05T06:00:00.000Z', day: '2099-01-05', day_label: 'Mon, 5 Jan', time: '06:00' },
  { event_id: 'm7', name: 'FORCE.', starts_at: '2099-01-05T07:00:00.000Z', day: '2099-01-05', day_label: 'Mon, 5 Jan', time: '07:00' },
  { event_id: 'm11', name: 'THE 50+ CLUB', starts_at: '2099-01-05T11:00:00.000Z', day: '2099-01-05', day_label: 'Mon, 5 Jan', time: '11:00' },
  { event_id: 't6', name: 'RECLA1M', starts_at: '2099-01-06T06:00:00.000Z', day: '2099-01-06', day_label: 'Tue, 6 Jan', time: '06:00' },
  { event_id: 't18', name: 'RECLA1M', starts_at: '2099-01-06T18:00:00.000Z', day: '2099-01-06', day_label: 'Tue, 6 Jan', time: '18:00' },
  { event_id: 'w9', name: 'CONVOY', starts_at: '2099-01-07T09:30:00.000Z', day: '2099-01-07', day_label: 'Wed, 7 Jan', time: '09:30' },
]

describe('ClassPickStep — day-first for a busy timetable', () => {
  it('isDayFirst: more than one slot on any day', () => {
    expect(isDayFirst(cadenceGroups(CLASSES))).toBe(false)
    expect(isDayFirst(cadenceGroups(BUSY))).toBe(true)
  })
  it('shows one tile per day and only the first day\'s slots; tapping a day swaps the slots; no More dates', () => {
    const onPick = vi.fn()
    mount({ list: loaded(BUSY), onPick, showClassName: true })
    const days = Array.from(document.querySelectorAll('[data-day]'))
    expect(days.map((d) => d.getAttribute('data-day'))).toEqual(['2099-01-05', '2099-01-06', '2099-01-07'])
    expect(days[0].getAttribute('aria-pressed')).toBe('true')
    const slots = () => Array.from(document.querySelectorAll('[data-tile]')).map((b) => b.getAttribute('data-tile'))
    expect(slots()).toEqual(['m6', 'm7', 'm11'])
    expect(screen.getByText('THE 50+ CLUB')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /More dates/ })).toBeNull()
    for (const b of [...days, ...document.querySelectorAll('[data-tile]')]) expect(b.getAttribute('type')).toBe('button')
    fireEvent.click(days[1])
    expect(slots()).toEqual(['t6', 't18'])
    fireEvent.click(document.querySelector('[data-tile="t18"]'))
    expect(onPick).toHaveBeenCalledWith(BUSY[4])
  })
  it('a chosen slot keeps its day in view and the continue button enabled', () => {
    mount({ list: loaded(BUSY), chosen: BUSY[5] })
    expect(document.querySelector('[data-day="2099-01-07"]').getAttribute('aria-pressed')).toBe('true')
    expect(document.querySelector('[data-tile="w9"]').getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: 'Next' }).disabled).toBe(false)
  })
})

describe('useClassList', () => {
  it('fetches the page and studio list once, reports it, and a reload key refetches', async () => {
    const calls = []
    vi.stubGlobal('fetch', vi.fn(async (url) => { calls.push(String(url)); return { json: async () => ({ success: true, data: { classes: CLASSES.slice(0, 1), campaign: { configured: true } } }) } }))
    const onLoaded = vi.fn()
    const { result, rerender } = renderHook(({ reloadKey }) => useClassList({ page: 'trial', publicPath: 'stillorgan', reloadKey, onLoaded }), { initialProps: { reloadKey: 0 } })
    expect(result.current.loading).toBe(true)
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(calls).toEqual(['/api/public/classes?page=trial&studio=stillorgan'])
    expect(result.current.classes).toHaveLength(1)
    expect(onLoaded).toHaveBeenCalledWith({ classes: CLASSES.slice(0, 1), configured: true, unavailable: false })
    rerender({ reloadKey: 1 })
    await waitFor(() => expect(calls).toHaveLength(2))
  })
  it('a failed fetch is unavailable, never an empty timetable; a disabled list fetches nothing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    const { result } = renderHook(() => useClassList({ page: 'corp', publicPath: 'hatch-street' }))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.unavailable).toBe(true)
    expect(result.current.classes).toEqual([])
    const { result: p } = renderHook(() => useClassList({ page: 'corp', publicPath: null, enabled: false }))
    expect(p.current.loading).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})

describe('helpers', () => {
  it('cadenceGroups orders by day and ctaLabelFor fills the weekday and time', () => {
    expect(cadenceGroups([CLASSES[2], CLASSES[0]]).map((g) => g.day)).toEqual(['2099-01-05', '2099-01-07'])
    expect(ctaLabelFor('Book {day} {time}', CLASSES[2])).toBe('Book Wed 11:00')
  })
  it('campaignFunnelClassesUrl: the page form, else the legacy path with an optional campaign', () => {
    expect(campaignFunnelClassesUrl({ page: 'trial', publicPath: 'hatch-street' })).toBe('/api/public/classes?page=trial&studio=hatch-street')
    expect(campaignFunnelClassesUrl({ publicPath: 'stillorgan', campaign: '50plus' })).toBe('/api/public/classes?path=stillorgan&campaign=50plus')
    expect(campaignFunnelClassesUrl({ publicPath: 'stillorgan' })).toBe('/api/public/classes?path=stillorgan')
  })
})
