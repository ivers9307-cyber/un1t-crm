import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  SWAP_CONFLICTS_CODE, isSwapConflictRefusal, swapConflictLines, swapConflictPrompt,
} from './swap-conflicts'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Real sentences as src/lib/swap-lifecycle.js swapConflictMessage words them.
const LEAVE = {
  kind: 'leave', role: 'taker', coachId: 'p1', date: '2026-09-20', type: 'holiday',
  startDate: '2026-09-19', endDate: '2026-09-21',
  message: 'Sam has approved holiday from 2026-09-19 to 2026-09-21, which covers the shift on 2026-09-20.',
}
const OVERLAP = {
  kind: 'overlap', role: 'requester', coachId: 'p2', date: '2026-09-20', shiftName: 'Open',
  locationName: 'Stillorgan', startTime: '09:00', endTime: '10:30', blockStart: '10:00', blockEnd: '11:00',
  message: 'Aoife is already on Open 09:00 to 10:30 at Stillorgan on 2026-09-20, which overlaps the shift (10:00 to 11:00).',
}
const UNCHECKED = {
  kind: 'check_failed', role: 'taker', coachId: 'p1', date: '2026-09-20',
  message: "Could not check Sam's leave and other shifts for 2026-09-20.",
}

function refusal(conflicts, extra = {}) {
  return {
    success: false,
    status: 409,
    code: 'swap_conflicts',
    error: conflicts.map((c) => c.message).join(' '),
    conflicts,
    ...extra,
  }
}

describe('SWAP_CONFLICTS_CODE', () => {
  it('matches the server constant in src/lib/swap-lifecycle.js (mobile cannot import it)', () => {
    const src = readFileSync(join(__dirname, '../../src/lib/swap-lifecycle.js'), 'utf8')
    const m = src.match(/export const SWAP_CONFLICTS_CODE = '([^']+)'/)
    expect(m?.[1]).toBe(SWAP_CONFLICTS_CODE)
  })
})

describe('isSwapConflictRefusal', () => {
  it('recognises the 409 conflicts refusal', () => {
    expect(isSwapConflictRefusal(refusal([LEAVE]))).toBe(true)
  })

  it('recognises it when api() carried no status', () => {
    const { status: _s, ...noStatus } = refusal([LEAVE])
    expect(isSwapConflictRefusal(noStatus)).toBe(true)
  })

  it('passes every other failure through (no override offered)', () => {
    // swap_stale / swap_not_open / a coach already ON that shift are 409s too.
    expect(isSwapConflictRefusal({ success: false, status: 409, error: 'This swap has already been decided' })).toBe(false)
    expect(isSwapConflictRefusal({ success: false, status: 409, error: 'A coach in this swap is already on that shift' })).toBe(false)
    expect(isSwapConflictRefusal({ success: false, status: 403, error: 'Forbidden' })).toBe(false)
    expect(isSwapConflictRefusal({ success: false, transport: true, error: 'Network error: x' })).toBe(false)
    expect(isSwapConflictRefusal({ success: false, status: 400, code: 'swap_conflicts', conflicts: [LEAVE] })).toBe(false)
  })

  it('never treats a success or a non-envelope as a refusal', () => {
    expect(isSwapConflictRefusal({ success: true, code: 'swap_conflicts' })).toBe(false)
    expect(isSwapConflictRefusal(null)).toBe(false)
    expect(isSwapConflictRefusal(undefined)).toBe(false)
    expect(isSwapConflictRefusal('swap_conflicts')).toBe(false)
  })
})

describe('swapConflictLines', () => {
  it('renders the server sentence for leave', () => {
    expect(swapConflictLines(refusal([LEAVE]))).toEqual([LEAVE.message])
  })

  it('renders the server sentence for an overlapping shift', () => {
    expect(swapConflictLines(refusal([OVERLAP]))).toEqual([OVERLAP.message])
  })

  it('renders check_failed as could-not-check, not a clash', () => {
    const [line] = swapConflictLines(refusal([UNCHECKED]))
    expect(line).toMatch(/^Could not check Sam's leave/)
  })

  it('keeps one line per conflict across both coaches, in order', () => {
    expect(swapConflictLines(refusal([LEAVE, OVERLAP, UNCHECKED]))).toEqual([
      LEAVE.message, OVERLAP.message, UNCHECKED.message,
    ])
  })

  it('drops a duplicate sentence', () => {
    expect(swapConflictLines(refusal([LEAVE, LEAVE]))).toEqual([LEAVE.message])
  })

  it('falls back per kind when a row has no message', () => {
    const strip = ({ message: _m, ...c }) => c
    expect(swapConflictLines({ ...refusal([]), conflicts: [strip(LEAVE), strip(OVERLAP), strip(UNCHECKED), { kind: 'mystery' }] })).toEqual([
      'A coach in this swap has approved leave on 2026-09-20.',
      'A coach in this swap is already on another shift 09:00 to 10:30 on 2026-09-20.',
      "Couldn't check a coach's leave and other shifts on 2026-09-20.",
      'This swap has a conflict.',
    ])
  })

  it('falls back to the error, then a generic sentence, with no usable rows', () => {
    expect(swapConflictLines({ success: false, code: 'swap_conflicts', error: 'Sam is on leave.', conflicts: [null] }))
      .toEqual(['Sam is on leave.'])
    expect(swapConflictLines({ success: false, code: 'swap_conflicts' })).toEqual(['This swap has a conflict.'])
  })
})

describe('swapConflictPrompt', () => {
  it('is null for anything that is not a conflicts refusal', () => {
    expect(swapConflictPrompt({ success: false, status: 409, error: 'This swap has already been decided' })).toBeNull()
    expect(swapConflictPrompt({ success: true })).toBeNull()
  })

  it('one conflict: the sentence, then the question', () => {
    const p = swapConflictPrompt(refusal([LEAVE]))
    expect(p.title).toBe('Check before approving')
    expect(p.message).toBe(`${LEAVE.message}\n\nApprove anyway?`)
    expect(p.uncheckedOnly).toBe(false)
  })

  it('several conflicts: bulleted', () => {
    const p = swapConflictPrompt(refusal([LEAVE, OVERLAP]))
    expect(p.message).toBe(`• ${LEAVE.message}\n• ${OVERLAP.message}\n\nApprove anyway?`)
    expect(p.lines).toHaveLength(2)
  })

  it('only unreadable checks: titled as a failed check, not a clash', () => {
    const p = swapConflictPrompt(refusal([UNCHECKED]))
    expect(p.title).toBe("Couldn't check this swap")
    expect(p.uncheckedOnly).toBe(true)
  })

  it('a real clash alongside an unreadable check keeps the clash title', () => {
    const p = swapConflictPrompt(refusal([UNCHECKED, OVERLAP]))
    expect(p.title).toBe('Check before approving')
    expect(p.uncheckedOnly).toBe(false)
  })
})
