// @vitest-environment jsdom
//
// SHELLYGROUPS.6 — one group: what it is doing (the reason line), ONE switch
// for every member, the members underneath, and the schedule editor pointed at
// the group's own PATCH route.
//
// The switch is amber "1 of 2 on" when members disagree: a display state, not
// a third command. A pending answer is branched on BEFORE anything paints the
// new state (the device card's rule 2), and the route's own sentence is shown.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, within, act } from '@testing-library/react'
import ShellyGroupCard, { groupReasonLine, groupSwitchState } from './ShellyGroupCard.jsx'

const TZ = 'Europe/Dublin'
// Monday 26 Oct 2026, 12:00 in Dublin (GMT: summer time ended the day before).
const NOW = Date.parse('2026-10-26T12:00:00.000Z')

const reading = (over = {}) => ({ online: true, output: true, apower: 42.4, aenergy_wh: 1200, at: new Date().toISOString(), ...over })

const devices = [
  { id: 'd1', name: 'Front light', group_id: 'g1', device_id: 'aa01', model: 'RGBW PM', last_state: reading(), last_seen_at: new Date().toISOString() },
  { id: 'd2', name: 'Back light', group_id: 'g1', device_id: 'aa02', model: 'RGBW PM', last_state: reading({ output: false, apower: null, aenergy_wh: null }), last_seen_at: new Date().toISOString() },
  { id: 'd3', name: 'Sauna plug', group_id: 'g1', device_id: 'aa03', model: 'Plug S', last_state: reading({ online: false, output: null, apower: null }), last_seen_at: new Date(Date.now() - 3 * 3600_000).toISOString() },
  { id: 'd4', name: 'Fan', group_id: null, device_id: 'aa04', model: 'Plug S', last_state: reading() },
]

const group = (over = {}) => ({
  id: 'g1',
  name: 'Studio lights',
  icon: 'bulb',
  sort_order: 0,
  enabled: true,
  schedule_mode: 'fixed',
  fixed_windows: [{ days: [1, 2, 3, 4, 5, 6, 7], on: '06:00', off: '21:00' }],
  class_rule: {},
  override: null,
  device_ids: ['d1', 'd2'],
  now: { on_count: 1, member_count: 2, mode: 'window', until: '2026-10-26T21:00:00.000Z', next_on: null },
  updated_at: '2026-10-26T10:00:00.000Z',
  ...over,
})

const answer = (status, json) => ({ ok: status >= 200 && status < 300, status, json: async () => json })

const originalFetch = global.fetch
beforeEach(() => { global.fetch = vi.fn() })
afterEach(() => { cleanup(); global.fetch = originalFetch })

// The group's one switch: role=button + aria-pressed (role=switch has no
// valid "mixed"), labelled "<name>: <state>".
const groupSwitch = (name = 'Studio lights') => screen.getByRole('button', { name: new RegExp(`^${name}: `) })

const renderCard = (g = group(), props = {}) => render(
  <ShellyGroupCard group={g} devices={devices} groups={[g]} connected locationTz={TZ} glofoxConnected onChanged={vi.fn()} {...props} />,
)

describe('groupSwitchState', () => {
  it('is mixed only when some but not all members are on', () => {
    expect(groupSwitchState({ on_count: 1, member_count: 2 })).toBe('mixed')
    expect(groupSwitchState({ on_count: 2, member_count: 2 })).toBe('on')
    expect(groupSwitchState({ on_count: 0, member_count: 2 })).toBe('off')
    expect(groupSwitchState({ on_count: 0, member_count: 0 })).toBe('empty')
    expect(groupSwitchState(undefined)).toBe('empty')
  })
})

describe('groupReasonLine', () => {
  const allOn = { on_count: 2, member_count: 2 }

  it('a class group inside a window: "Follows classes · on until 19:10"', () => {
    const g = group({ schedule_mode: 'class', now: { ...allOn, mode: 'window', until: '2026-10-26T19:10:00.000Z' } })
    expect(groupReasonLine(g, TZ, NOW)).toBe('Follows classes · on until 19:10')
  })

  it('a fixed group shows today\'s hours: "Fixed hours · 06:00–21:00"', () => {
    expect(groupReasonLine(group({ now: { ...allOn, mode: 'window', until: '2026-10-26T21:00:00.000Z' } }), TZ, NOW))
      .toBe('Fixed hours · 06:00–21:00')
  })

  it('a fixed group with no hours today says so', () => {
    const g = group({ fixed_windows: [{ days: [6, 7], on: '08:00', off: '12:00' }], now: { ...allOn, mode: 'idle', until: null, next_on: null } })
    expect(groupReasonLine(g, TZ, NOW)).toBe('Fixed hours · off today')
  })

  it('a mixed group under a manual switch: "1 of 2 on · manual until midnight"', () => {
    const g = group({
      override: { state: 'on', until: '2026-10-27T00:00:00.000Z', set_by: 'u1', set_at: '2026-10-26T11:00:00.000Z' },
      now: { on_count: 1, member_count: 2, mode: 'override', until: '2026-10-27T00:00:00.000Z', next_on: null },
    })
    expect(groupReasonLine(g, TZ, NOW)).toBe('1 of 2 on · manual until midnight')
  })

  it('a manual switch that ends at another time names it', () => {
    const g = group({ now: { ...allOn, mode: 'override', until: '2026-10-26T15:00:00.000Z', next_on: null } })
    expect(groupReasonLine(g, TZ, NOW)).toBe('Manual until 15:00')
  })

  it('a group no schedule runs: "Never automatic"', () => {
    expect(groupReasonLine(group({ schedule_mode: 'none', now: { ...allOn, mode: 'none', until: null, next_on: null } }), TZ, NOW))
      .toBe('Never automatic')
  })

  it('a class group waiting for its next class says when', () => {
    const g = group({ schedule_mode: 'class', now: { ...allOn, mode: 'idle', until: null, next_on: '2026-10-26T17:45:00.000Z' } })
    expect(groupReasonLine(g, TZ, NOW)).toBe('Follows classes · next on at 17:45')
  })

  it('never invents a time when the timetable could not be read', () => {
    const g = group({ schedule_mode: 'class', now: { ...allOn, mode: 'idle', until: null, next_on: null, windows_unread: true } })
    expect(groupReasonLine(g, TZ, NOW)).toBe("Follows classes · couldn't read today's classes")
  })
})

describe('ShellyGroupCard — the switch', () => {
  it('shows "1 of 2 on" in the mixed state', () => {
    renderCard()
    const sw = groupSwitch()
    expect(sw.textContent).toContain('1 of 2 on')
    expect(sw.getAttribute('aria-pressed')).toBe('mixed')
  })

  it('a fully-on group switches every member off, with no `until` for "until midnight"', async () => {
    global.fetch.mockResolvedValue(answer(200, { success: true, applied: 'all', pending_device_ids: [] }))
    renderCard(group({ now: { on_count: 2, member_count: 2, mode: 'window', until: null } }))
    fireEvent.click(groupSwitch())
    await waitFor(() => expect(global.fetch).toHaveBeenCalled())
    const [url, init] = global.fetch.mock.calls[0]
    expect(url).toBe('/api/shelly/groups/g1/toggle')
    expect(JSON.parse(init.body)).toEqual({ state: 'off' })
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Switched off.'))
  })

  it('a mixed group switches every member on', async () => {
    global.fetch.mockResolvedValue(answer(200, { success: true, applied: 'all', pending_device_ids: [] }))
    renderCard()
    fireEvent.click(groupSwitch())
    await waitFor(() => expect(global.fetch).toHaveBeenCalled())
    expect(JSON.parse(global.fetch.mock.calls[0][1].body)).toEqual({ state: 'on' })
  })

  it('a partial answer shows the route\'s sentence, not "Switched on."', async () => {
    const message = 'Saved. 1 of 2 did not answer — it will follow as soon as it is back online.'
    global.fetch.mockResolvedValue(answer(200, { success: true, applied: 'partial', pending_device_ids: ['d2'], message }))
    renderCard()
    fireEvent.click(groupSwitch())
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain(message))
    expect(screen.queryByText('Switched on.')).toBeNull()
  })

  it('a batch that landed nowhere is pending, even on a 429', async () => {
    const message = 'Saved. Shelly is busy right now — the group will follow within a minute.'
    global.fetch.mockResolvedValue(answer(429, { success: true, applied: 'none', pending: true, code: 'rate_limited', message }))
    renderCard()
    fireEvent.click(groupSwitch())
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain(message))
  })

  it('"Back to schedule" posts auto', async () => {
    global.fetch.mockResolvedValue(answer(200, { success: true, applied: 'all', pending_device_ids: [], results: [] }))
    renderCard()
    fireEvent.click(screen.getByRole('button', { name: 'Back to schedule' }))
    await waitFor(() => expect(global.fetch).toHaveBeenCalled())
    expect(JSON.parse(global.fetch.mock.calls[0][1].body)).toEqual({ state: 'auto' })
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Back on schedule.'))
  })

  it('an empty group has nothing to switch', () => {
    renderCard(group({ device_ids: [], now: { on_count: 0, member_count: 0, mode: 'none', until: null, next_on: null } }))
    expect(groupSwitch().disabled).toBe(true)
  })
})

describe('ShellyGroupCard — members', () => {
  it('lists each member with watts, "Offline" or "Doesn\'t report power"', () => {
    renderCard(group({ device_ids: ['d1', 'd2', 'd3'], now: { on_count: 1, member_count: 3, mode: 'window', until: null } }))
    const list = screen.getByRole('list', { name: 'Devices in this group' })
    const rows = within(list).getAllByRole('listitem')
    expect(rows).toHaveLength(3)
    expect(rows[0].textContent).toContain('Front light')
    expect(rows[0].textContent).toContain('42 W')
    expect(rows[1].textContent).toContain('Doesn’t report power')
    expect(rows[2].textContent).toContain('Offline')
    // A device outside the group is not listed.
    expect(list.textContent).not.toContain('Fan')
  })

  it('"Edit devices" opens the members editor', () => {
    renderCard()
    expect(screen.queryByRole('button', { name: 'Save devices' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Edit devices' }))
    expect(screen.getByRole('button', { name: 'Save devices' })).toBeTruthy()
  })
})

describe('ShellyGroupCard — the schedule', () => {
  it('saves to the GROUP route', async () => {
    global.fetch.mockResolvedValue(answer(200, { success: true, group: {} }))
    renderCard()
    fireEvent.click(screen.getByLabelText('Never automatic'))
    fireEvent.click(screen.getByRole('button', { name: /Save schedule/ }))
    await waitFor(() => expect(global.fetch).toHaveBeenCalled())
    const [url, init] = global.fetch.mock.calls[0]
    expect(url).toBe('/api/shelly/groups/g1')
    expect(init.method).toBe('PATCH')
    expect(JSON.parse(init.body)).toEqual({ schedule_mode: 'none', enabled: false })
  })

  it('a switched-off group reads as "Never automatic" and picking hours switches it on', async () => {
    global.fetch.mockResolvedValue(answer(200, { success: true, group: {} }))
    renderCard(group({ enabled: false, now: { on_count: 0, member_count: 2, mode: 'none', until: null, next_on: null } }))
    expect(screen.getByLabelText('Never automatic').checked).toBe(true)
    fireEvent.click(screen.getByLabelText('Fixed hours'))
    fireEvent.click(screen.getByRole('button', { name: /Save schedule/ }))
    await waitFor(() => expect(global.fetch).toHaveBeenCalled())
    expect(JSON.parse(global.fetch.mock.calls[0][1].body)).toEqual({ schedule_mode: 'fixed', enabled: true })
  })

  it('shows the route\'s refusal', async () => {
    global.fetch.mockResolvedValue(answer(400, { success: false, error: 'Invalid request', issues: [{ message: 'Pick at least one day' }] }))
    renderCard()
    fireEvent.click(screen.getByLabelText('Never automatic'))
    fireEvent.click(screen.getByRole('button', { name: /Save schedule/ }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Pick at least one day'))
  })
})

// SHELLYGROUPS.8 — carry-overs from the Task 10 review.
describe('groupReasonLine — fixed hours that started yesterday', () => {
  it('an overnight window still open says when it ends, not "off today"', () => {
    // Sunday's 22:00–02:00 is still open at 01:00 on Monday, and Monday has no window of its own.
    const g = group({
      fixed_windows: [{ days: [7], on: '22:00', off: '02:00' }],
      now: { on_count: 2, member_count: 2, mode: 'window', until: '2026-10-26T02:00:00.000Z', next_on: null },
    })
    expect(groupReasonLine(g, TZ, Date.parse('2026-10-26T01:00:00.000Z'))).toBe('Fixed hours · on until 02:00')
  })
})

describe('ShellyGroupCard — "Back to schedule" worded from results', () => {
  const backToSchedule = async (body) => {
    global.fetch.mockResolvedValue(answer(200, body))
    renderCard(group({ device_ids: ['d1', 'd2', 'd3'], now: { on_count: 1, member_count: 3, mode: 'window', until: null } }))
    fireEvent.click(screen.getByRole('button', { name: 'Back to schedule' }))
    await waitFor(() => expect(screen.getByRole('status')).toBeTruthy())
    return screen.getByRole('status').textContent
  }

  it('an unreadable timetable says so, not "will follow when back online"', async () => {
    const text = await backToSchedule({
      success: true,
      applied: 'none',
      pending_device_ids: ['d1', 'd2', 'd3'],
      results: ['d1', 'd2', 'd3'].map((id) => ({ device_id: id, applied: null, code: 'occurrences' })),
    })
    expect(text).toContain("Couldn't read today's classes")
    expect(text).not.toMatch(/back online/)
  })

  it('a permanent refusal names the device and says Shelly refused it', async () => {
    const text = await backToSchedule({
      success: true,
      applied: 'partial',
      pending_device_ids: ['d2'],
      results: [
        { device_id: 'd1', applied: 'on', reason: 'fixed' },
        { device_id: 'd2', applied: null, code: 'device', shelly_code: 'DEVICE_NOT_FOUND', permanent: true },
        { device_id: 'd3', applied: 'on', reason: 'fixed' },
      ],
    })
    expect(text).toContain('Shelly refused Back light')
    expect(text).not.toMatch(/back online/)
  })

  it('only a member that did not answer gets "will follow when back online"', async () => {
    const text = await backToSchedule({
      success: true,
      applied: 'partial',
      pending_device_ids: ['d3'],
      results: [
        { device_id: 'd1', applied: 'on', reason: 'fixed' },
        { device_id: 'd2', applied: 'on', reason: 'fixed' },
        { device_id: 'd3', applied: null, code: 'device', shelly_code: 'DEVICE_OFFLINE', permanent: false },
      ],
    })
    expect(text).toContain('Sauna plug')
    expect(text).toMatch(/will follow when (it is|it's) back online/)
    expect(text).not.toContain('refused')
  })
})

describe('ShellyGroupCard — pending answers keep the "stays as you set it" notice', () => {
  it('shows the route\'s notice alongside a partial answer', async () => {
    const message = 'Saved. 1 of 2 did not answer — it will follow as soon as it is back online.'
    const notice = 'No schedule is running this group, so its lights stay as you set them until you change them'
    global.fetch.mockResolvedValue(answer(200, {
      success: true, applied: 'partial', pending: true, pending_device_ids: ['d2'], message, holds_until_changed: true, notice,
    }))
    renderCard(group({ enabled: false, now: { on_count: 1, member_count: 2, mode: 'none', until: null, next_on: null } }))
    fireEvent.click(groupSwitch())
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain(message))
    expect(screen.getByRole('status').textContent).toContain(notice)
  })
})

describe('ShellyGroupCard — one action at a time', () => {
  it('the switch is disabled while "Back to schedule" is in flight', async () => {
    global.fetch.mockReturnValue(new Promise(() => {}))
    renderCard()
    fireEvent.click(screen.getByRole('button', { name: 'Back to schedule' }))
    await waitFor(() => expect(groupSwitch().disabled).toBe(true))
  })

  it('the switch is disabled while a delete is in flight', async () => {
    global.fetch.mockReturnValue(new Promise(() => {}))
    renderCard()
    fireEvent.click(screen.getByRole('button', { name: 'Delete group' }))
    const confirm = screen.getAllByRole('button', { name: 'Delete group' }).at(-1)
    fireEvent.click(confirm)
    await waitFor(() => expect(groupSwitch().disabled).toBe(true))
  })
})

describe('ShellyGroupCard — rename', () => {
  it('renames through PATCH { name }', async () => {
    const onChanged = vi.fn()
    global.fetch.mockResolvedValue(answer(200, { success: true, group: { id: 'g1', name: 'Gym floor' } }))
    renderCard(group(), { onChanged })
    fireEvent.click(screen.getByRole('button', { name: 'Rename Studio lights' }))
    const input = screen.getByLabelText('Group name')
    fireEvent.change(input, { target: { value: '  Gym floor ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save name' }))
    await waitFor(() => expect(global.fetch).toHaveBeenCalled())
    const [url, init] = global.fetch.mock.calls[0]
    expect(url).toBe('/api/shelly/groups/g1')
    expect(init.method).toBe('PATCH')
    expect(JSON.parse(init.body)).toEqual({ name: 'Gym floor' })
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
    expect(screen.queryByLabelText('Group name')).toBeNull()
  })

  it('a taken name says so and keeps the editor open', async () => {
    global.fetch.mockResolvedValue(answer(409, { success: false, error: 'A group with that name already exists here', code: 'name_taken' }))
    renderCard()
    fireEvent.click(screen.getByRole('button', { name: 'Rename Studio lights' }))
    fireEvent.change(screen.getByLabelText('Group name'), { target: { value: 'Fans' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save name' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('A group with that name already exists'))
    expect(screen.getByLabelText('Group name')).toBeTruthy()
  })

  it('Escape cancels without a request', () => {
    renderCard()
    fireEvent.click(screen.getByRole('button', { name: 'Rename Studio lights' }))
    fireEvent.keyDown(screen.getByLabelText('Group name'), { key: 'Escape' })
    expect(screen.queryByLabelText('Group name')).toBeNull()
    expect(global.fetch).not.toHaveBeenCalled()
  })
})

describe('ShellyGroupCard — rename has its own saving flag', () => {
  it('Enter while a rename save is in flight sends nothing more, and the switch stays usable', async () => {
    global.fetch.mockReturnValue(new Promise(() => {}))
    renderCard()
    fireEvent.click(screen.getByRole('button', { name: 'Rename Studio lights' }))
    const input = screen.getByLabelText('Group name')
    fireEvent.change(input, { target: { value: 'Gym floor' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.click(screen.getByRole('button', { name: 'Save name' }))
    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1))
    expect(groupSwitch().disabled).toBe(false)
  })
})

describe('autoOutcomeText — a member the page does not know', () => {
  it('is named "a device"', async () => {
    global.fetch.mockResolvedValue(answer(200, {
      success: true, applied: 'partial', pending_device_ids: ['gone'],
      results: [{ device_id: 'd1', applied: 'on' }, { device_id: 'gone', applied: null, code: 'device', permanent: true }],
    }))
    renderCard()
    fireEvent.click(screen.getByRole('button', { name: 'Back to schedule' }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Shelly refused a device'))
  })
})

describe('ShellyGroupCard — final-review fixes (SHELLYGROUPS.8)', () => {
  it('the switch is a pressed-state button: aria-pressed true, false or mixed, never role=switch', () => {
    const { rerender } = renderCard()
    expect(screen.queryByRole('switch')).toBeNull()
    expect(groupSwitch().getAttribute('aria-pressed')).toBe('mixed')
    rerender(<ShellyGroupCard group={group({ now: { on_count: 2, member_count: 2, mode: 'window', until: null } })} devices={devices} groups={[group()]} connected locationTz={TZ} glofoxConnected onChanged={vi.fn()} />)
    expect(groupSwitch().getAttribute('aria-pressed')).toBe('true')
    rerender(<ShellyGroupCard group={group({ now: { on_count: 0, member_count: 2, mode: 'window', until: null } })} devices={devices} groups={[group()]} connected locationTz={TZ} glofoxConnected onChanged={vi.fn()} />)
    expect(groupSwitch().getAttribute('aria-pressed')).toBe('false')
  })

  it('"Back to schedule" and Delete are locked while the switch is in flight', async () => {
    global.fetch.mockReturnValue(new Promise(() => {}))
    renderCard()
    fireEvent.click(groupSwitch())
    await waitFor(() => expect(screen.getByRole('button', { name: 'Back to schedule' }).disabled).toBe(true))
    expect(screen.getByRole('button', { name: 'Delete group' }).disabled).toBe(true)
  })

  it('the delete confirm is locked while "Back to schedule" is in flight', async () => {
    global.fetch.mockReturnValue(new Promise(() => {}))
    renderCard()
    fireEvent.click(screen.getByRole('button', { name: 'Delete group' }))
    fireEvent.click(screen.getByRole('button', { name: 'Back to schedule' }))
    await waitFor(() => expect(groupSwitch().disabled).toBe(true))
    expect(screen.getAllByRole('button', { name: 'Delete group' }).at(-1).disabled).toBe(true)
  })

  it('"Back to schedule" words a plan_mismatch member as not switched', async () => {
    global.fetch.mockResolvedValue(answer(200, {
      success: true,
      applied: 'partial',
      pending_device_ids: ['d2'],
      results: [
        { device_id: 'd1', applied: 'on', reason: 'fixed' },
        { device_id: 'd2', applied: null, code: 'plan_mismatch' },
      ],
    }))
    renderCard()
    fireEvent.click(screen.getByRole('button', { name: 'Back to schedule' }))
    await waitFor(() => expect(screen.getByRole('status')).toBeTruthy())
    const text = screen.getByRole('status').textContent
    expect(text).toContain('Back on schedule for 1 of 2.')
    expect(text).toContain('Back light was not switched.')
    expect(text).not.toMatch(/back online/)
  })

  it('the result line clears itself after about 10 seconds', async () => {
    vi.useFakeTimers()
    try {
      global.fetch.mockResolvedValue(answer(200, { success: true, applied: 'all', pending_device_ids: [] }))
      renderCard()
      await act(async () => { fireEvent.click(groupSwitch()) })
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      expect(screen.getByRole('status').textContent).toContain('Switched on.')
      await act(async () => { await vi.advanceTimersByTimeAsync(9_000) })
      expect(screen.queryByRole('status')).not.toBeNull()
      await act(async () => { await vi.advanceTimersByTimeAsync(1_500) })
      expect(screen.queryByRole('status')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a pending result clears on the next poll that shows every member as asked', async () => {
    global.fetch.mockResolvedValue(answer(200, { success: true, applied: 'partial', pending: true, pending_device_ids: ['d2'], message: 'Saved. 1 of 2 did not answer.' }))
    const props = { devices, groups: [group()], connected: true, locationTz: TZ, glofoxConnected: true, onChanged: vi.fn() }
    const { rerender } = render(<ShellyGroupCard group={group()} {...props} />)
    fireEvent.click(groupSwitch())
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Saved. 1 of 2 did not answer.'))
    // A poll that still disagrees keeps it.
    rerender(<ShellyGroupCard group={group({ now: { on_count: 1, member_count: 2, mode: 'override', until: null } })} {...props} />)
    expect(screen.queryByRole('status')).not.toBeNull()
    // A poll where every member is on, as asked, clears it.
    rerender(<ShellyGroupCard group={group({ now: { on_count: 2, member_count: 2, mode: 'override', until: null } })} {...props} />)
    expect(screen.queryByRole('status')).toBeNull()
  })
})
