// src/lib/roster-compare.test.js
// SNAPSHOT.1 — the comparison model. Pure: every clock and zone is passed in.
// Run it under TZ=Europe/Dublin AND a US zone (CLAUDE.md date rule); nothing
// here may depend on the host's zone.

import { describe, it, expect } from 'vitest'
import {
  hhmm, windowHours, effectiveWindow, buildPublishSnapshot, clipWindow, compareSnapshot, SNAPSHOT_FORMAT_VERSION,
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

// ── compareSnapshot ───────────────────────────────────────────────────────

const AFTER_WEEK = Date.UTC(2026, 8, 25, 12) // Fri 25 Sep 12:00Z: every shift in WEEK has ended

function snap(blocks, [from, to] = WEEK) {
  return buildPublishSnapshot({ periodStart: from, periodEnd: to, blocks }).snapshot
}

function cmp(snapshot, current, extra = {}) {
  return compareSnapshot({ snapshot, currentBlocks: current, nowMs: AFTER_WEEK, tz: 'Europe/Dublin', ...extra })
}

function coach(result, date, pid) {
  for (const b of result.blocks) {
    if (b.date !== date) continue
    const r = b.coaches.find((c) => c.profile_id === pid)
    if (r) return r
  }
  return undefined
}

function changes(result) {
  return Object.fromEntries(result.blocks.flatMap((b) => b.coaches.map((c) => [c.profile_id, c.change])))
}

// An Evening block on the same Tuesday.
function pm(over = {}) {
  return blk({
    id: 'b-pm-15', template_id: 't-pm', start_time: '18:00:00', end_time: '19:00:00',
    shift_templates: { name: 'Evening', kind: 'class' }, ...over,
  })
}

describe('clipWindow', () => {
  const s = { period_start: '2026-09-14', period_end: '2026-09-20' }
  it('is the published period when nothing narrower is asked', () => {
    expect(clipWindow(s, null, null)).toEqual({ from: '2026-09-14', to: '2026-09-20' })
  })
  it('narrows to the period asked, never past the published one', () => {
    expect(clipWindow(s, '2026-09-17', '2026-09-30')).toEqual({ from: '2026-09-17', to: '2026-09-20' })
    expect(clipWindow(s, '2026-09-01', '2026-09-15')).toEqual({ from: '2026-09-14', to: '2026-09-15' })
  })
  it('is null when the two do not overlap', () => {
    expect(clipWindow(s, '2026-10-01', '2026-10-07')).toBeNull()
  })
})

describe('compareSnapshot — change classes', () => {
  it('nothing changed: every coach unchanged, hours equal', () => {
    const blocks = [blk({ shift_assignments: [asg('a'), asg('b')] })]
    const r = cmp(snap(blocks), blocks)
    expect(r.window).toEqual({ from: '2026-09-14', to: '2026-09-20' })
    expect(r.blocks).toHaveLength(1)
    expect(r.blocks[0]).toMatchObject({ change: 'unchanged', staffing_changed: false, template_name: 'Morning', kind: 'class' })
    expect(r.blocks[0].coaches.map((c) => [c.name, c.change])).toEqual([['Coach A', 'unchanged'], ['Coach B', 'unchanged']])
    expect(r.totals).toMatchObject({
      published_shifts: 2, current_shifts: 2, published_hours: 2, current_hours: 2, hours_delta: 0,
      unchanged: 2, moved: 0, added: 0, removed: 0,
    })
  })

  it("a coach whose window changed after publish is 'moved', with both windows", () => {
    const pub = [blk({ shift_assignments: [asg('a')] })]
    const now = [blk({ shift_assignments: [asg('a', { start_time_override: '06:30:00' })] })]
    expect(coach(cmp(snap(pub), now), '2026-09-15', 'a')).toMatchObject({
      change: 'moved', published: { start: '06:00', end: '07:00' }, current: { start: '06:30', end: '07:00' },
    })
  })

  it('a block moved after publish moves every coach on it, and the block says so', () => {
    const pub = [blk({ shift_assignments: [asg('a')] })]
    const now = [blk({ start_time: '07:00:00', end_time: '08:00:00', shift_assignments: [asg('a')] })]
    const r = cmp(snap(pub), now)
    expect(r.blocks[0]).toMatchObject({
      change: 'moved',
      published: { start: '06:00', end: '07:00' },
      current: { start: '07:00', end: '08:00' },
    })
    expect(r.blocks[0].coaches[0].change).toBe('moved')
    expect(r.totals.blocks_moved).toBe(1)
  })

  it('a minimum or maximum changed after publish is flagged on the block, times unchanged', () => {
    const r = cmp(snap([blk()]), [blk({ min_coaches: 2, max_coaches: 3 })])
    expect(r.blocks[0]).toMatchObject({
      change: 'unchanged', staffing_changed: true,
      published: { min: 1, max: 2 }, current: { min: 2, max: 3 },
    })
    expect(r.totals.blocks_staffing_changed).toBe(1)
  })

  it('coaches added and removed after publish; a cancelled assignment reads as removed', () => {
    const pub = [blk({ shift_assignments: [asg('a'), asg('b')] })]
    const now = [blk({ shift_assignments: [asg('a'), asg('b', { status: 'cancelled' }), asg('c')] })]
    const r = cmp(snap(pub), now)
    expect(coach(r, '2026-09-15', 'b')).toMatchObject({ change: 'removed', current: null, name: 'Coach B' })
    expect(coach(r, '2026-09-15', 'c')).toMatchObject({ change: 'added', published: null, current: { start: '06:00', end: '07:00' } })
    expect(r.totals).toMatchObject({ added: 1, removed: 1, unchanged: 1 })
  })

  it('a swap reads as the giver removed and the taker added', () => {
    const pub = [blk({ shift_assignments: [asg('a')] })]
    // A swap rewrites profile_id on the SAME row and marks it swapped.
    const now = [blk({ shift_assignments: [asg('b', { id: 'a-a', status: 'swapped' })] })]
    expect(changes(cmp(snap(pub), now))).toEqual({ a: 'removed', b: 'added' })
  })

  it('a block removed after publish, and one added after publish', () => {
    const pub = [blk({ shift_assignments: [asg('a')] }), pm()]
    const now = [blk({
      id: 'b-sat', template_id: 't-sat', block_date: '2026-09-19', start_time: '09:00:00', end_time: '10:00:00',
      shift_templates: { name: 'Saturday', kind: 'class' }, shift_assignments: [asg('c')],
    })]
    const r = cmp(snap(pub), now)
    const byName = Object.fromEntries(r.blocks.map((b) => [b.template_name, b]))
    expect(byName.Morning).toMatchObject({ change: 'removed', current: null })
    expect(byName.Morning.coaches[0]).toMatchObject({ profile_id: 'a', change: 'removed' })
    expect(byName.Evening).toMatchObject({ change: 'removed', coaches: [] })
    expect(byName.Saturday).toMatchObject({ change: 'added', published: null })
    expect(byName.Saturday.coaches[0]).toMatchObject({ profile_id: 'c', change: 'added' })
    expect(r.totals).toMatchObject({ blocks_removed: 2, blocks_added: 1 })
  })

  it('a block deleted and made again for the same slot (new ids) is the same shift', () => {
    const r = cmp(
      snap([blk({ shift_assignments: [asg('a')] })]),
      [blk({ id: 'b-new', shift_assignments: [asg('a', { id: 'a-new' })] })],
    )
    expect(r.blocks[0].change).toBe('unchanged')
    expect(coach(r, '2026-09-15', 'a').change).toBe('unchanged')
  })

  it('hours: published against now, and the difference', () => {
    const pub = [
      blk({ shift_assignments: [asg('a'), asg('b')] }),
      pm({ end_time: '20:00:00', shift_assignments: [asg('a')] }),
    ]
    const now = [
      blk({ shift_assignments: [asg('a', { end_time_override: '06:30:00' })] }),
      pm({ end_time: '20:00:00', shift_assignments: [asg('a'), asg('c')] }),
    ]
    // published: a 1h + b 1h + a 2h = 4h; now: a 0.5h + a 2h + c 2h = 4.5h
    expect(cmp(snap(pub), now).totals).toMatchObject({
      published_shifts: 3, published_hours: 4, current_shifts: 3, current_hours: 4.5, hours_delta: 0.5,
    })
  })

  it('names a coach who is no longer on the roster from the names map, else null', () => {
    const pub = [blk({ shift_assignments: [asg('a'), asg('z')] })]
    const now = [blk({ shift_assignments: [asg('a')] })]
    expect(coach(cmp(snap(pub), now, { names: { z: 'Zoe' } }), '2026-09-15', 'z').name).toBe('Zoe')
    expect(coach(cmp(snap(pub), now), '2026-09-15', 'z').name).toBeNull()
  })

  it('orders shifts by date, then start', () => {
    const blocks = [pm({ shift_assignments: [asg('a')] }), blk({ shift_assignments: [asg('a')] }), blk({ id: 'b-14', block_date: '2026-09-14' })]
    expect(cmp(snap(blocks), blocks).blocks.map((b) => `${b.date} ${(b.current || b.published).start}`))
      .toEqual(['2026-09-14 06:00', '2026-09-15 06:00', '2026-09-15 18:00'])
  })

  it('carries no pay', () => {
    const blocks = [blk({ shift_assignments: [asg('a')] })]
    expect(JSON.stringify(cmp(snap(blocks), blocks))).not.toMatch(/rate|cost|salary|eur/i)
  })
})

describe('compareSnapshot — the window', () => {
  it('narrows both sides to the period on screen, clipped to what was published', () => {
    const blocks = [blk({ shift_assignments: [asg('a')] }), blk({ id: 'b-19', block_date: '2026-09-19', shift_assignments: [asg('b')] })]
    const r = cmp(snap(blocks), blocks, { from: '2026-09-17', to: '2026-09-30' })
    expect(r.window).toEqual({ from: '2026-09-17', to: '2026-09-20' })
    expect(r.blocks.map((b) => b.date)).toEqual(['2026-09-19'])
    expect(r.totals.published_shifts).toBe(1)
  })

  it('a window that misses the published period is null, with nothing in it', () => {
    const r = cmp(snap([blk()]), [blk()], { from: '2026-10-01', to: '2026-10-07' })
    expect(r.window).toBeNull()
    expect(r.blocks).toEqual([])
    expect(r.totals.published_shifts).toBe(0)
  })
})

describe('compareSnapshot — as arrived (advisory)', () => {
  it("an arrival stamp is shown in the studio's own time", () => {
    const now = [blk({ shift_assignments: [asg('a', { arrived_at: '2026-09-15T04:58:00Z' })] })]
    expect(coach(cmp(snap(now), now), '2026-09-15', 'a')).toMatchObject({
      arrived_at: '2026-09-15T04:58:00.000Z', arrived_local: '05:58', arrival_inferred: false,
      ended: true, no_show_candidate: false,
    })
  })

  it('an ended shift with no arrival is a no-show CANDIDATE; a back-to-back shift inherits the arrival', () => {
    const blocks = [
      blk({ shift_assignments: [asg('a', { arrived_at: '2026-09-15T04:55:00Z' }), asg('b')] }),
      blk({
        id: 'b-mid', template_id: 't-mid', start_time: '07:00:00', end_time: '08:00:00',
        shift_templates: { name: 'Midmorning', kind: 'class' }, shift_assignments: [asg('a', { id: 'a-a2' })],
      }),
    ]
    const r = cmp(snap(blocks), blocks)
    const [am, mid] = r.blocks
    expect(am.coaches.find((c) => c.profile_id === 'b')).toMatchObject({ ended: true, arrived_at: null, no_show_candidate: true })
    expect(mid.coaches[0]).toMatchObject({ arrival_inferred: true, arrived_local: '05:55', no_show_candidate: false })
    expect(r.totals).toMatchObject({ ended: 3, arrived: 2, arrived_inferred: 1, no_show_candidates: 1 })
  })

  it('a shift that has not ended is never a candidate, and a removed coach never is', () => {
    const period = ['2026-09-14', '2026-09-30']
    const pub = [blk({ block_date: '2026-09-28', shift_assignments: [asg('a'), asg('b')] })]
    const now = [blk({ block_date: '2026-09-28', shift_assignments: [asg('a')] })]
    const r = cmp(snap(pub, period), now)
    expect(coach(r, '2026-09-28', 'a')).toMatchObject({ ended: false, no_show_candidate: false })
    expect(coach(r, '2026-09-28', 'b')).toMatchObject({ change: 'removed', ended: false, no_show_candidate: false })
    expect(r.totals.ended).toBe(0)
  })
})

describe('compareSnapshot — clocks', () => {
  it("judges 'ended' on the studio's clock across the spring change (29 Mar 2026: 07:00 IST is 06:00Z)", () => {
    const b = [blk({ block_date: '2026-03-29', shift_assignments: [asg('a')] })]
    const s = snap(b, ['2026-03-23', '2026-03-29'])
    expect(coach(cmp(s, b, { nowMs: Date.UTC(2026, 2, 29, 5, 59) }), '2026-03-29', 'a').ended).toBe(false)
    expect(coach(cmp(s, b, { nowMs: Date.UTC(2026, 2, 29, 6, 0) }), '2026-03-29', 'a').ended).toBe(true)
  })

  it('and in winter 07:00 is 07:00Z', () => {
    const b = [blk({ block_date: '2026-11-02', shift_assignments: [asg('a')] })]
    const s = snap(b, ['2026-11-02', '2026-11-08'])
    expect(coach(cmp(s, b, { nowMs: Date.UTC(2026, 10, 2, 6, 30) }), '2026-11-02', 'a').ended).toBe(false)
    expect(coach(cmp(s, b, { nowMs: Date.UTC(2026, 10, 2, 7, 0) }), '2026-11-02', 'a').ended).toBe(true)
  })

  it('counts a shift across the spring change at its wall-clock length, as payroll does', () => {
    const b = [blk({ block_date: '2026-03-29', start_time: '00:30:00', end_time: '03:30:00', shift_assignments: [asg('a')] })]
    expect(cmp(snap(b, ['2026-03-23', '2026-03-29']), b).totals.current_hours).toBe(3)
  })

  it('an overnight window (end before start) counts past midnight and ends the next morning', () => {
    const b = [blk({ start_time: '18:00:00', end_time: '23:00:00', shift_assignments: [asg('a', { end_time_override: '01:00:00' })] })]
    const s = snap(b)
    expect(cmp(s, b).totals.current_hours).toBe(7)
    // 01:00 on Wed 16 Sep, Irish Standard (summer) Time, is 00:00Z.
    expect(coach(cmp(s, b, { nowMs: Date.UTC(2026, 8, 15, 23, 59) }), '2026-09-15', 'a').ended).toBe(false)
    expect(coach(cmp(s, b, { nowMs: Date.UTC(2026, 8, 16, 0, 0) }), '2026-09-15', 'a').ended).toBe(true)
  })

  it("a '24:00' end is the next midnight", () => {
    const b = [blk({ start_time: '22:00:00', end_time: '24:00:00', shift_assignments: [asg('a')] })]
    const s = snap(b)
    expect(cmp(s, b).totals.current_hours).toBe(2)
    // Midnight starting Wed 16 Sep is 23:00Z on the 15th.
    expect(coach(cmp(s, b, { nowMs: Date.UTC(2026, 8, 15, 22, 59) }), '2026-09-15', 'a').ended).toBe(false)
    expect(coach(cmp(s, b, { nowMs: Date.UTC(2026, 8, 15, 23, 0) }), '2026-09-15', 'a').ended).toBe(true)
  })

  it('an unknown studio zone falls back to Dublin rather than throwing', () => {
    const b = [blk({ shift_assignments: [asg('a', { arrived_at: '2026-09-15T04:58:00Z' })] })]
    expect(coach(cmp(snap(b), b, { tz: 'Mars/Olympus' }), '2026-09-15', 'a').arrived_local).toBe('05:58')
  })
})

describe('compareSnapshot — re-published twice', () => {
  // Publish 1: A on the Morning, B on the Evening.
  // Then A moves to 06:30 and C joins the Morning. Publish 2.
  // Then B is taken off the Evening and D joins it. Nobody publishes again.
  const p1 = [blk({ shift_assignments: [asg('a')] }), pm({ shift_assignments: [asg('b')] })]
  const p2 = [blk({ shift_assignments: [asg('a', { start_time_override: '06:30:00' }), asg('c')] }), pm({ shift_assignments: [asg('b')] })]
  const now = [
    blk({ shift_assignments: [asg('a', { start_time_override: '06:30:00' }), asg('c')] }),
    pm({ shift_assignments: [asg('b', { status: 'cancelled' }), asg('d')] }),
  ]
  const s1 = snap(p1)
  const s2 = snap(p2)

  it('against the FIRST publish: everything since it', () => {
    expect(changes(cmp(s1, now))).toEqual({ a: 'moved', b: 'removed', c: 'added', d: 'added' })
  })

  it('against the LATEST publish: only what changed since it', () => {
    expect(changes(cmp(s2, now))).toEqual({ a: 'unchanged', b: 'removed', c: 'unchanged', d: 'added' })
  })

  it('each snapshot is its own record: publish 2 against publish 1 shows exactly its edits', () => {
    expect(changes(cmp(s1, p2))).toEqual({ a: 'moved', b: 'unchanged', c: 'added' })
  })
})

describe('compareSnapshot — the autumn change', () => {
  // 25 Oct 2026: 02:00 IST becomes 01:00 GMT, so the week of 19-25 Oct has one
  // 25-hour day. Wall clock rules, as in payroll.
  it("judges 'ended' on the studio's clock on the day the clocks go back (07:00 GMT is 07:00Z)", () => {
    const b = [blk({ block_date: '2026-10-25', shift_assignments: [asg('a')] })]
    const s = snap(b, ['2026-10-19', '2026-10-25'])
    expect(coach(cmp(s, b, { nowMs: Date.UTC(2026, 9, 25, 6, 59) }), '2026-10-25', 'a').ended).toBe(false)
    expect(coach(cmp(s, b, { nowMs: Date.UTC(2026, 9, 25, 7, 0) }), '2026-10-25', 'a').ended).toBe(true)
  })

  it('the Saturday before is still summer time (07:00 IST is 06:00Z)', () => {
    const b = [blk({ block_date: '2026-10-24', shift_assignments: [asg('a')] })]
    const s = snap(b, ['2026-10-19', '2026-10-25'])
    expect(coach(cmp(s, b, { nowMs: Date.UTC(2026, 9, 24, 5, 59) }), '2026-10-24', 'a').ended).toBe(false)
    expect(coach(cmp(s, b, { nowMs: Date.UTC(2026, 9, 24, 6, 0) }), '2026-10-24', 'a').ended).toBe(true)
  })

  it('counts a shift across the autumn change at its wall-clock length, as payroll does', () => {
    const b = [blk({ block_date: '2026-10-25', start_time: '00:30:00', end_time: '03:30:00', shift_assignments: [asg('a')] })]
    expect(cmp(snap(b, ['2026-10-19', '2026-10-25']), b).totals.current_hours).toBe(shiftHours({ start_time: '00:30', end_time: '03:30' }))
    expect(cmp(snap(b, ['2026-10-19', '2026-10-25']), b).totals.current_hours).toBe(3)
  })

  it('an arrival stamp in the fall-back week reads in GMT after the change', () => {
    const b = [blk({ block_date: '2026-10-26', shift_assignments: [asg('a', { arrived_at: '2026-10-26T05:58:00Z' })] })]
    expect(coach(cmp(snap(b, ['2026-10-26', '2026-11-01']), b), '2026-10-26', 'a').arrived_local).toBe('05:58')
  })
})

describe('compareSnapshot — the briefing (BLOCKEDIT.1)', () => {
  it('added, changed and removed after publish, on a block that is otherwise unchanged', () => {
    const cases = [
      [null, 'Fire drill at 10', 'added'],
      ['Fire drill at 10', 'Fire drill at 11', 'changed'],
      ['Fire drill at 10', null, 'removed'],
      ['Fire drill at 10', '  Fire drill at 10 ', null],
      [null, '   ', null],
    ]
    for (const [was, now, want] of cases) {
      const r = cmp(snap([blk({ briefing: was })]), [blk({ briefing: now })])
      expect(r.blocks[0], `${was} -> ${now}`).toMatchObject({ change: 'unchanged', briefing_change: want })
      expect(r.totals.blocks_briefing_changed, `${was} -> ${now}`).toBe(want ? 1 : 0)
    }
  })

  it('a block added or removed after publish carries no briefing change of its own', () => {
    const r = cmp(snap([blk({ briefing: 'x' })]), [pm({ briefing: 'y' })])
    expect(r.blocks.map((b) => [b.change, b.briefing_change])).toEqual([['removed', null], ['added', null]])
  })

  it('a snapshot that never recorded the briefing reads as unknown, never as a change', () => {
    const s = snap([blk()])
    delete s.blocks[0].briefing_hash
    const r = cmp(s, [blk({ briefing: 'Fire drill at 10' })])
    expect(r.blocks[0].briefing_change).toBeNull()
  })

  it('never returns the briefing text or its fingerprint', () => {
    const r = cmp(snap([blk({ briefing: 'Fire drill at 10' })]), [blk({ briefing: 'Aoife covers' })])
    const out = JSON.stringify(r)
    expect(out).not.toMatch(/Fire drill|Aoife|briefing_hash/)
  })
})
