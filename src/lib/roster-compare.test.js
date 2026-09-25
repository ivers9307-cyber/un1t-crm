// src/lib/roster-compare.test.js
// SNAPSHOT.1 — the comparison model. Pure: every clock and zone is passed in.
// Run it under TZ=Europe/Dublin AND a US zone (CLAUDE.md date rule); nothing
// here may depend on the host's zone.

import { describe, it, expect } from 'vitest'
import {
  hhmm, windowHours, effectiveWindow, buildPublishSnapshot, SNAPSHOT_FORMAT_VERSION,
} from './roster-compare'
import { shiftHours } from './payroll'

const WEEK = ['2026-09-14', '2026-09-20']

// A Morning block on Tue 15 Sep 06:00-07:00. The TEMPLATE says 09:00-10:00 on
// purpose: a window must never fall back to it.
function blk(over = {}) {
  return {
    id: 'b-am-15',
    template_id: 't-am',
    block_date: '2026-09-15',
    start_time: '06:00:00',
    end_time: '07:00:00',
    min_coaches: 1,
    max_coaches: 2,
    shift_templates: { name: 'Morning', kind: 'class', start_time: '09:00:00', end_time: '10:00:00' },
    shift_assignments: [],
    ...over,
  }
}

function asg(pid, over = {}) {
  return {
    id: `a-${pid}`,
    profile_id: pid,
    status: 'scheduled',
    start_time_override: null,
    end_time_override: null,
    arrived_at: null,
    profiles: { full_name: `Coach ${pid.toUpperCase()}` },
    ...over,
  }
}

describe('hhmm', () => {
  it('reads Postgres time text as HH:MM and refuses anything else', () => {
    expect(hhmm('06:00:00')).toBe('06:00')
    expect(hhmm('06:30')).toBe('06:30')
    expect(hhmm('23:59:59.5')).toBe('23:59')
    expect(hhmm('24:00:00')).toBe('24:00')
    expect(hhmm('24:30')).toBeNull()
    expect(hhmm('6:00')).toBeNull()
    expect(hhmm(null)).toBeNull()
    expect(hhmm('late')).toBeNull()
  })
})

describe('windowHours', () => {
  it('counts wall-clock hours, wrapping past midnight, exactly as payroll does', () => {
    for (const [start, end] of [['06:00', '07:00'], ['06:15', '07:45'], ['18:00', '01:00'], ['00:30', '03:30']]) {
      expect(windowHours({ start, end }), `${start}-${end}`).toBe(shiftHours({ start_time: start, end_time: end }))
    }
    expect(windowHours({ start: '18:00', end: '01:00' })).toBe(7)
  })

  it("reads a '24:00' end as midnight", () => {
    expect(windowHours({ start: '22:00', end: '24:00' })).toBe(2)
    // payroll.timeToHours refuses hour 24, so payroll counts this 0h. Pinned
    // so the day someone fixes payroll, this line tells them to delete it
    // (the follow-up in 32-SNAPSHOT.1.md).
    expect(shiftHours({ start_time: '22:00', end_time: '24:00' })).toBe(0)
  })

  it('is 0 for an unreadable window, never NaN', () => {
    expect(windowHours({ start: null, end: '07:00' })).toBe(0)
    expect(windowHours({ start: '06:00', end: 'late' })).toBe(0)
    expect(windowHours(null)).toBe(0)
  })
})

describe('effectiveWindow', () => {
  it("is the coach's override, else the block's own time, never the template", () => {
    const b = blk()
    expect(effectiveWindow(asg('a'), b)).toEqual({ start: '06:00', end: '07:00' })
    expect(effectiveWindow(asg('a', { start_time_override: '06:30:00' }), b)).toEqual({ start: '06:30', end: '07:00' })
    expect(effectiveWindow(asg('a', { end_time_override: '06:45:00' }), b)).toEqual({ start: '06:00', end: '06:45' })
  })
})

describe('buildPublishSnapshot', () => {
  it('records each block and each LIVE coach with their window; a cancelled coach was not published', () => {
    const { snapshot, blockCount, assignmentCount } = buildPublishSnapshot({
      periodStart: WEEK[0],
      periodEnd: WEEK[1],
      blocks: [blk({
        shift_assignments: [
          asg('b'),
          asg('a', { start_time_override: '06:30:00' }),
          asg('c', { status: 'cancelled' }),
          asg('d', { status: 'swapped' }),
        ],
      })],
    })
    expect(blockCount).toBe(1)
    expect(assignmentCount).toBe(3)
    expect(snapshot).toEqual({
      v: SNAPSHOT_FORMAT_VERSION,
      period_start: '2026-09-14',
      period_end: '2026-09-20',
      blocks: [{
        slot: 't-am|2026-09-15',
        block_id: 'b-am-15',
        date: '2026-09-15',
        template_id: 't-am',
        template_name: 'Morning',
        kind: 'class',
        start: '06:00',
        end: '07:00',
        min: 1,
        max: 2,
        briefing_hash: null,
        coaches: [
          { assignment_id: 'a-a', profile_id: 'a', start: '06:30', end: '07:00', overridden: true },
          { assignment_id: 'a-b', profile_id: 'b', start: '06:00', end: '07:00', overridden: false },
          { assignment_id: 'a-d', profile_id: 'd', start: '06:00', end: '07:00', overridden: false },
        ],
      }],
    })
  })

  it('keeps only the period, in date then start order, and records each kind', () => {
    const { snapshot, blockCount } = buildPublishSnapshot({
      periodStart: WEEK[0],
      periodEnd: WEEK[1],
      blocks: [
        blk({ id: 'x', template_id: 't-pm', start_time: '18:00:00', end_time: '19:00:00', shift_templates: { name: 'Evening', kind: 'class' } }),
        blk({ id: 'y', template_id: 't-desk', block_date: '2026-09-14', start_time: '09:00:00', end_time: '13:00:00', min_coaches: 0, shift_templates: { name: 'Front desk', kind: 'admin' } }),
        blk(),
        blk({ id: 'z', block_date: '2026-09-21' }),
      ],
    })
    expect(blockCount).toBe(3)
    expect(snapshot.blocks.map((b) => [b.date, b.start, b.kind, b.template_name])).toEqual([
      ['2026-09-14', '09:00', 'admin', 'Front desk'],
      ['2026-09-15', '06:00', 'class', 'Morning'],
      ['2026-09-15', '18:00', 'class', 'Evening'],
    ])
  })

  it('survives a JSON round trip unchanged: what jsonb stores is what is read back', () => {
    const { snapshot } = buildPublishSnapshot({ periodStart: WEEK[0], periodEnd: WEEK[1], blocks: [blk({ shift_assignments: [asg('a')] })] })
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot)
  })

  it('an empty period is an empty snapshot, not an error', () => {
    expect(buildPublishSnapshot({ periodStart: WEEK[0], periodEnd: WEEK[1], blocks: [] })).toEqual({
      snapshot: { v: 1, period_start: '2026-09-14', period_end: '2026-09-20', blocks: [] },
      blockCount: 0,
      assignmentCount: 0,
    })
  })

  // BLOCKEDIT.1's briefing (mig 629) is part of what coaches were told, so the
  // snapshot records it, as a fingerprint and never the text: free text in an
  // immutable row is out of reach of any later correction or erasure, and the
  // change log keeps the text out of its details for the same reason.
  it('records the briefing as a fingerprint, never its text; blank is no briefing', () => {
    const text = 'Fire drill at 10, Aoife covers the door'
    const { snapshot } = buildPublishSnapshot({
      periodStart: WEEK[0],
      periodEnd: WEEK[1],
      blocks: [
        blk({ briefing: text }),
        blk({ id: 'b2', template_id: 't2', briefing: `  ${text}\n` }),
        blk({ id: 'b3', template_id: 't3', briefing: '   ' }),
        blk({ id: 'b4', template_id: 't4' }),
      ],
    })
    const [a, b, c, d] = snapshot.blocks
    expect(a.briefing_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(b.briefing_hash).toBe(a.briefing_hash)
    expect(c.briefing_hash).toBeNull()
    expect(d.briefing_hash).toBeNull()
    expect(JSON.stringify(snapshot)).not.toMatch(/Fire drill|Aoife/)
  })

  it('carries no pay: no rate, cost or salary anywhere in the document', () => {
    const { snapshot } = buildPublishSnapshot({ periodStart: WEEK[0], periodEnd: WEEK[1], blocks: [blk({ shift_assignments: [asg('a')] })] })
    expect(JSON.stringify(snapshot)).not.toMatch(/rate|cost|salary|eur/i)
  })
})
