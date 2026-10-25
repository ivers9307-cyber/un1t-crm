// mobile/lib/swap-cards.test.js
// COVERLOOP.2 — what the phone's swap surfaces say and decide. Pure: there is
// no React Native component test runner, so the components only render these.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  swapDayLabel, swapShiftWhen, postedSwapShift, swapReasonForPost, swapConfirmCopy, swapPostedCopy,
  hasOpenSwap, annotateOpenSwaps,
  SWAP_PENDING_LABEL, SWAP_PICKER_TITLE, SWAP_PICKER_EMPTY, SWAP_ALREADY_OPEN_MESSAGE, SWAP_REASON_MAX,
} from './swap-cards'

// 2026-09-24 is a Thursday.
const tpl = { name: 'Morning', start_time: '06:00:00', end_time: '07:00:00' }

describe('swapDayLabel', () => {
  it.each([
    ['2026-09-24', 'Thu 24 Sep'],
    ['2099-01-01', 'Thu 1 Jan'],
    ['2026-10-25', 'Sun 25 Oct'], // clocks-back day: a calendar date has no timezone
    ['2026-02-31', ''],
    ['next week', ''],
    [undefined, ''],
  ])('%s -> "%s"', (iso, expected) => {
    expect(swapDayLabel(iso)).toBe(expected)
  })
})

describe('swapShiftWhen', () => {
  it.each([
    {
      name: "the BLOCK's hours, not the requester's personal 06:15 paid window (the taker works the block)",
      shift: { shift_date: '2026-09-24', block_start_time: '06:00:00', block_end_time: '07:00:00', start_time_override: '06:15:00', end_time_override: null, shift_templates: tpl },
      expected: 'Thu 24 Sep · 06:00-07:00',
    },
    {
      name: 'an older API with no block_* keys: the collapsed override (a block moved off its template)',
      shift: { shift_date: '2026-09-24', start_time_override: '07:30:00', end_time_override: '08:30:00', shift_templates: { name: 'Early', start_time: '08:00:00', end_time: '09:00:00' } },
      expected: 'Thu 24 Sep · 07:30-08:30',
    },
    {
      name: 'nothing but the template',
      shift: { shift_date: '2026-09-24', start_time_override: null, end_time_override: null, shift_templates: tpl },
      expected: 'Thu 24 Sep · 06:00-07:00',
    },
    { name: 'a date and no times', shift: { shift_date: '2026-09-24' }, expected: 'Thu 24 Sep' },
    { name: 'times and no date', shift: { block_start_time: '06:00:00', block_end_time: '07:00:00' }, expected: '06:00-07:00' },
    { name: 'half a time range is no time range', shift: { shift_date: '2026-09-24', block_start_time: '06:00:00' }, expected: 'Thu 24 Sep' },
    { name: 'a detached shift (mig 603 NULLed it)', shift: null, expected: '' },
  ])('$name', ({ shift, expected }) => {
    expect(swapShiftWhen(shift)).toBe(expected)
  })

  it('never prints a raw ISO date', () => {
    expect(swapShiftWhen({ shift_date: '2026-09-24', shift_templates: tpl })).not.toContain('2026-')
  })
})

describe('postedSwapShift', () => {
  it("maps the dashboard's posted-swap row onto the shift shape swapShiftWhen reads", () => {
    const swap = { id: 's1', requester_shift: { shift_blocks: { block_date: '2026-09-24', start_time: '06:00:00', end_time: '07:00:00', shift_templates: { name: 'Morning' } } } }
    expect(postedSwapShift(swap)).toEqual({
      shift_date: '2026-09-24', block_start_time: '06:00:00', block_end_time: '07:00:00', shift_templates: { name: 'Morning' },
    })
    expect(swapShiftWhen(postedSwapShift(swap))).toBe('Thu 24 Sep · 06:00-07:00')
  })
  it('a swap whose shift is gone gives an empty label, not a crash', () => {
    expect(swapShiftWhen(postedSwapShift({ id: 's1', requester_shift: null }))).toBe('')
  })
})

describe('swapReasonForPost', () => {
  it.each([
    ['  physio appointment  ', 'physio appointment'],
    ['', null],
    ['   ', null],
    [null, null],
    [undefined, null],
    [42, null],
  ])('%j -> %j', (input, expected) => {
    expect(swapReasonForPost(input)).toBe(expected)
  })
  it('caps at the API limit (SwapCreateSchema: max 2000) instead of earning a 400', () => {
    expect(SWAP_REASON_MAX).toBe(2000)
    expect(swapReasonForPost('x'.repeat(2500))).toHaveLength(2000)
  })
})

describe('swapConfirmCopy', () => {
  const shift = { shift_date: '2026-09-24', block_start_time: '06:00:00', block_end_time: '07:00:00', shift_templates: tpl }

  it('a targeted request names the coach, the shift and when', () => {
    expect(swapConfirmCopy({ shift, coach: { id: 'c1', full_name: 'Coach T' } })).toEqual({
      title: 'Ask a coach to cover',
      message: 'Ask Coach T to take Morning on Thu 24 Sep · 06:00-07:00? They can accept or decline, then a manager approves it.',
      reasonHint: 'Shown to the coach you ask and to your manager.',
      cta: 'Send request',
    })
  })

  it('an open post says who is told', () => {
    expect(swapConfirmCopy({ shift, coach: null })).toEqual({
      title: 'Post for swap',
      message: 'Post Morning on Thu 24 Sep · 06:00-07:00 for another coach to take? Coaches who can cover it and your managers are told, and a manager approves whoever takes it.',
      reasonHint: 'Shown to your manager only.',
      cta: 'Post shift',
    })
  })

  it('degrades without a name, a template or a date', () => {
    expect(swapConfirmCopy({ shift: {}, coach: { id: 'c1', full_name: null } }).message)
      .toBe('Ask this coach to take this shift? They can accept or decline, then a manager approves it.')
    expect(swapConfirmCopy({ shift: null, coach: null }).message)
      .toBe('Post this shift for another coach to take? Coaches who can cover it and your managers are told, and a manager approves whoever takes it.')
  })
})

describe('swapPostedCopy', () => {
  it('targeted', () => {
    expect(swapPostedCopy({ full_name: 'Coach T' })).toEqual({ title: 'Request sent', message: 'Coach T has been asked to take this shift.' })
    expect(swapPostedCopy({ full_name: '' }).message).toBe('They have been asked to take this shift.')
  })
  it('open', () => {
    expect(swapPostedCopy(null)).toEqual({ title: 'Posted', message: 'Coaches who can cover it and your managers have been notified.' })
  })
})

describe('hasOpenSwap', () => {
  it.each([
    [{ open_swap_status: 'pending' }, true],
    [{ open_swap_status: 'awaiting_approval' }, true],
    [{ open_swap_status: 'approved' }, false],
    [{ open_swap_status: null }, false],
    [{}, false],
    [null, false],
  ])('%j -> %s', (shift, expected) => {
    expect(hasOpenSwap(shift)).toBe(expected)
  })
})

describe('annotateOpenSwaps', () => {
  const shifts = [{ id: 'a1', shift_date: '2026-09-24' }, { id: 'a2', shift_date: '2026-09-25' }]

  it('joins a dashboard shift (id = assignment id) to my posted swap on it', () => {
    const out = annotateOpenSwaps(shifts, [{ id: 's1', status: 'awaiting_approval', requester_shift_id: 'a2' }])
    expect(out.map((s) => s.open_swap_status)).toEqual([null, 'awaiting_approval'])
    expect(out[0]).toEqual({ id: 'a1', shift_date: '2026-09-24', open_swap_status: null })
  })
  it('ignores decided swaps and detached ones', () => {
    const out = annotateOpenSwaps(shifts, [{ status: 'cancelled', requester_shift_id: 'a1' }, { status: 'pending', requester_shift_id: null }])
    expect(out.map((s) => s.open_swap_status)).toEqual([null, null])
  })
  it('does not mutate, and survives non-arrays', () => {
    annotateOpenSwaps(shifts, [{ status: 'pending', requester_shift_id: 'a1' }])
    expect(shifts[0]).toEqual({ id: 'a1', shift_date: '2026-09-24' })
    expect(annotateOpenSwaps(null, null)).toEqual([])
    expect(annotateOpenSwaps(shifts, undefined).map((s) => s.open_swap_status)).toEqual([null, null])
  })
})

describe('labels', () => {
  it('are the agreed strings', () => {
    expect(SWAP_PENDING_LABEL).toBe('Swap pending')
    expect(SWAP_PICKER_TITLE).toBe('Ask a coach to cover')
    expect(SWAP_PICKER_EMPTY).toBe('No other coaches at this studio to ask.')
    expect(SWAP_ALREADY_OPEN_MESSAGE).toBe('A swap request is already open for this shift. You can cancel it under My requests on the Dashboard tab.')
  })
})

// An open post tells eligible coaches as well as managers, so "Managers have
// been notified." was untrue, and the Schedule tab and the Dashboard said
// different things about the same POST. Both read swapPostedCopy; there is no
// RN component runner, so the wiring is pinned by reading the two sources.
describe('one success message for an open post, on both surfaces', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const surfaces = [
    '../app/(staff)/(tabs)/schedule.jsx',
    '../components/dashboard/PersonalDashboard.jsx',
  ]
  it.each(surfaces)('%s uses swapPostedCopy and carries no wording of its own', (rel) => {
    const src = readFileSync(join(here, rel), 'utf8')
    expect(src).toContain('swapPostedCopy(')
    expect(src).not.toContain('Managers have been notified')
  })
  it('says who is told, truthfully for both', () => {
    expect(swapPostedCopy(null).message).toBe('Coaches who can cover it and your managers have been notified.')
  })
})
