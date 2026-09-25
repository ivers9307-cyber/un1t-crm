// src/lib/shift-replace.test.js
// REPLACE.1a — the pure half of "replace coach": may this assignment go from
// coach A to coach B now, what the log and the notices say, and what the held
// notice arm sends.
import { describe, it, expect } from 'vitest'
import {
  replaceRefusal, replaceRefusalResponse, replaceShiftStarted, replaceChanges,
  replaceNoticeWhen, replaceResponseOutcome, replacePickerCopy, netReplaceChanges, bandSeenBetween,
  REPLACE_VIA, REPLACE_SWAP_CLOSE_NOTE, REPLACE_UNDONE_REASON,
} from './shift-replace'
// The phone's Alert says the same words (mobile cannot import src/lib).
import { replaceResultAlert } from '../../mobile/lib/schedule-manage'

// Tue 29 Sep 2026, Dublin summer time (UTC+1): 06:00 Dublin = 05:00Z.
const BLOCK = { id: 'b1', location_id: 'loc-1', block_date: '2026-09-29', start_time: '06:00:00', end_time: '07:00:00' }
const A = { id: 'as-1', profile_id: 'coach-a', block_id: 'b1', status: 'scheduled', arrived_at: null, start_time_override: null }
const B_OK = { toIsMember: true, toProfile: { id: 'coach-b', full_name: 'Coach B', active: true, deleted_at: null }, liveOnBlockIds: ['coach-a'] }
const TZ = 'Europe/Dublin'

describe('replaceRefusal', () => {
  const ask = (over = {}) => replaceRefusal({ assignment: A, block: BLOCK, toProfileId: 'coach-b', started: false, ...B_OK, ...over })

  it('allows a live, unstarted shift to go to a rosterable member of the studio', () => {
    expect(ask()).toBeNull()
  })

  it('refuses, first thing a manager can act on first', () => {
    expect(ask({ assignment: { ...A, status: 'cancelled' } }).code).toBe('not_live')
    expect(ask({ assignment: null }).code).toBe('not_live')
    expect(ask({ toProfileId: 'coach-a' }).code).toBe('same_coach')
    expect(ask({ assignment: { ...A, arrived_at: '2026-09-29T04:58:00Z' } }).code).toBe('already_arrived')
    expect(ask({ started: true }).code).toBe('shift_started')
    expect(ask({ toIsMember: false }).code).toBe('not_at_studio')
    expect(ask({ liveOnBlockIds: ['coach-a', 'coach-b'] }).code).toBe('already_on_shift')
  })

  it('a deactivated or deleted coach is refused in the assign route\'s words', () => {
    expect(ask({ toProfile: { id: 'coach-b', full_name: 'Coach B', active: false } }))
      .toEqual({ code: 'profile_not_rosterable', status: 400, error: expect.stringMatching(/^Coach B is deactivated/) })
    expect(ask({ toProfile: { id: 'coach-b', full_name: 'Coach B', active: false, deleted_at: '2026-09-01' } }).error)
      .toMatch(/permanently deleted/)
  })

  it('a non-member is refused BEFORE their profile is judged (nothing foreign is described)', () => {
    expect(ask({ toIsMember: false, toProfile: null }).code).toBe('not_at_studio')
  })

  it('carries a status and the words', () => {
    expect(ask({ started: true })).toEqual({ code: 'shift_started', status: 409, error: expect.stringMatching(/already started/) })
    expect(ask({ toProfileId: 'coach-a' }).status).toBe(400)
  })
})

describe('replaceRefusalResponse', () => {
  it('maps a code from the write to its status and words', () => {
    expect(replaceRefusalResponse('changed')).toEqual({ status: 409, body: { success: false, code: 'changed', error: 'This shift has just changed. Refresh and try again.' } })
    expect(replaceRefusalResponse('already_on_shift').status).toBe(409)
  })
})

describe('replaceShiftStarted: the one predicate, on the block start and on the outgoing coach\'s own start', () => {
  it('not started before the block starts', () => {
    expect(replaceShiftStarted({ block: BLOCK, assignment: A }, Date.parse('2026-09-29T04:59:00Z'), TZ)).toBe(false)
  })
  it('started at the block start, studio clock', () => {
    expect(replaceShiftStarted({ block: BLOCK, assignment: A }, Date.parse('2026-09-29T05:00:00Z'), TZ)).toBe(true)
  })
  it('an outgoing coach who started EARLIER on an override counts', () => {
    const early = { ...A, start_time_override: '05:30:00' }
    expect(replaceShiftStarted({ block: BLOCK, assignment: early }, Date.parse('2026-09-29T04:45:00Z'), TZ)).toBe(true)
  })
  it('a LATER override does not delay it: the incoming coach works the block', () => {
    const late = { ...A, start_time_override: '06:30:00' }
    expect(replaceShiftStarted({ block: BLOCK, assignment: late }, Date.parse('2026-09-29T05:10:00Z'), TZ)).toBe(true)
  })
  it('a past day has started', () => {
    expect(replaceShiftStarted({ block: { ...BLOCK, block_date: '2026-09-20' }, assignment: A }, Date.parse('2026-09-29T04:00:00Z'), TZ)).toBe(true)
  })
  it('an unreadable date is NOT started: never refuse on a guess', () => {
    expect(replaceShiftStarted({ block: { ...BLOCK, block_date: 'nope' }, assignment: A }, Date.parse('2026-09-29T09:00:00Z'), TZ)).toBe(false)
  })
})

describe('replaceChanges', () => {
  it('two entries, A off and B on, each with the shift start', () => {
    expect(replaceChanges({ block: BLOCK, fromProfileId: 'coach-a', toProfileId: 'coach-b' })).toEqual([
      { blockId: 'b1', blockDate: '2026-09-29', startTime: '06:00:00', coachId: 'coach-a', action: 'unassigned' },
      { blockId: 'b1', blockDate: '2026-09-29', startTime: '06:00:00', coachId: 'coach-b', action: 'assigned' },
    ])
  })
})

describe('replaceNoticeWhen', () => {
  it('a draft tells nobody now; a published shift tells now in band, from 07:00 out of it', () => {
    expect(replaceNoticeWhen({ published: false, inBand: true })).toBe('none')
    expect(replaceNoticeWhen({ published: true, inBand: true })).toBe('now')
    expect(replaceNoticeWhen({ published: true, inBand: false })).toBe('morning')
  })
})

describe('replaceResponseOutcome (the web toast)', () => {
  const names = { fromName: 'Coach A', toName: 'Coach B' }
  it('a conflicts refusal asks to confirm, in the server\'s sentences', () => {
    const body = { success: false, code: 'swap_conflicts', error: 'x', conflicts: [{ message: 'Coach B has approved holiday on 2026-09-29, which covers the shift on 2026-09-29.' }] }
    expect(replaceResponseOutcome(409, body, names)).toEqual({ kind: 'confirm', message: body.conflicts[0].message })
  })
  it('any other failure is an error in the server\'s words', () => {
    expect(replaceResponseOutcome(409, { success: false, code: 'shift_started', error: 'This shift has already started.' }, names))
      .toEqual({ kind: 'error', message: 'This shift has already started.' })
    expect(replaceResponseOutcome(500, {}, names)).toEqual({ kind: 'error', message: 'Could not replace the coach.' })
  })
  it('success says who is told and when', () => {
    const done = (notice) => replaceResponseOutcome(200, { success: true, data: { notice } }, names)
    expect(done('now')).toEqual({ kind: 'done', tone: 'success', message: 'Coach B is on the shift. Coach A and Coach B have been told.' })
    expect(done('morning')).toEqual({ kind: 'done', tone: 'warning', message: 'Coach B is on the shift. Coach A and Coach B are told after 7am; if the shift is before then, ring them.' })
    expect(done('none')).toEqual({ kind: 'done', tone: 'success', message: 'Coach B is on the shift. The roster is a draft, so nobody is told until it is published.' })
  })
})

describe('the phone says exactly what the web says', () => {
  it.each(['now', 'morning', 'none'])('notice %s', (notice) => {
    const names = { fromName: 'Coach A', toName: 'Coach B' }
    expect(replaceResultAlert({ success: true, data: { notice } }, names).message)
      .toBe(replaceResponseOutcome(200, { success: true, data: { notice } }, names).message)
  })
})

describe('replacePickerCopy', () => {
  it('titles the picker after the coach going off, and the button after the pick', () => {
    expect(replacePickerCopy({ fromName: 'Coach A' })).toEqual({ title: 'Replace Coach A', label: 'Pick the coach who takes this shift', submit: 'Pick a coach' })
    expect(replacePickerCopy({ fromName: 'Coach A', pickedName: 'Coach B' }).submit).toBe('Replace with Coach B')
    expect(replacePickerCopy({ fromName: null, pickedName: 'Coach B', saving: true })).toMatchObject({ title: 'Replace coach', submit: 'Replacing…' })
  })
})

describe('netReplaceChanges (the held-notice arm)', () => {
  const row = (id, coach, action, at, over = {}) => ({
    id, location_id: 'loc-1', block_id: 'b1', block_date: '2026-09-29', actor_id: 'mgr-1',
    coach_id: coach, action, created_at: `2026-09-28T22:${at}:00Z`, shift_blocks: { start_time: '06:00:00' }, ...over,
  })

  it('one replace: one change per coach, with the shift start and every row id', () => {
    const { send, silent } = netReplaceChanges([row('r1', 'coach-a', 'unassigned', '10'), row('r2', 'coach-b', 'assigned', '10')])
    expect(silent).toEqual([])
    expect(send).toEqual([
      { locationId: 'loc-1', actorId: 'mgr-1', coachId: 'coach-a', blockId: 'b1', blockDate: '2026-09-29', startTime: '06:00:00', action: 'unassigned', rowIds: ['r1'] },
      { locationId: 'loc-1', actorId: 'mgr-1', coachId: 'coach-b', blockId: 'b1', blockDate: '2026-09-29', startTime: '06:00:00', action: 'assigned', rowIds: ['r2'] },
    ])
  })

  it('replaced and put back overnight nets to nothing: silent, every row listed for stamping', () => {
    const rows = [
      row('r1', 'coach-a', 'unassigned', '10'), row('r2', 'coach-b', 'assigned', '10'),
      row('r3', 'coach-b', 'unassigned', '40'), row('r4', 'coach-a', 'assigned', '40'),
    ]
    const { send, silent } = netReplaceChanges(rows)
    expect(send).toEqual([])
    expect(silent.flatMap((s) => s.rowIds).sort()).toEqual(['r1', 'r2', 'r3', 'r4'])
  })

  it('the LAST action wins for an uneven pile, and its actor is the one told about', () => {
    const rows = [
      row('r1', 'coach-a', 'unassigned', '10'),
      row('r2', 'coach-a', 'assigned', '20', { actor_id: 'mgr-2' }),
      row('r3', 'coach-a', 'unassigned', '30', { actor_id: 'mgr-2' }),
    ]
    expect(netReplaceChanges(rows).send).toEqual([
      expect.objectContaining({ coachId: 'coach-a', action: 'unassigned', actorId: 'mgr-2', rowIds: ['r1', 'r2', 'r3'] }),
    ])
  })

  // REPLACE.1a review 1 — "put back before anyone was told" is only true if
  // nobody COULD have been told. A row the route's after() sent (created in
  // band) or an earlier in-band tick sent, whose stamp then failed, is still
  // unstamped: treating its pile as net zero would tell B "added" and never
  // "removed". Such a pile tells the LAST action instead (a duplicate at
  // worst, never a loss).
  it('a balanced pile with a row that may already have been told is NOT silent: the last action is told', () => {
    const rows = [row('r2', 'coach-b', 'assigned', '10'), row('r3', 'coach-b', 'unassigned', '40')]
    const { send, silent } = netReplaceChanges(rows, { mayHaveBeenTold: (r) => r.id === 'r2' })
    expect(silent).toEqual([])
    expect(send).toEqual([expect.objectContaining({ coachId: 'coach-b', action: 'unassigned', rowIds: ['r2', 'r3'] })])
  })

  it('a balanced pile nobody could have been told about stays silent', () => {
    const rows = [row('r2', 'coach-b', 'assigned', '10'), row('r3', 'coach-b', 'unassigned', '40')]
    expect(netReplaceChanges(rows, { mayHaveBeenTold: () => false }).silent).toHaveLength(1)
  })

  it('a row with no coach, no block or no date is ignored', () => {
    expect(netReplaceChanges([row('r1', null, 'assigned', '10'), row('r2', 'coach-a', 'assigned', '10', { block_id: null })]))
      .toEqual({ send: [], silent: [] })
  })
})

describe('bandSeenBetween: was there a moment in [from, to) when a notice could have gone out?', () => {
  const TZ = 'Europe/Dublin'
  // 28-29 Sep 2026: Dublin is UTC+1, so the quiet night is 21:00Z-06:00Z.
  it('a row made at 23:00 and read at 06:55 the same night: no, never in band', () => {
    expect(bandSeenBetween(Date.parse('2026-09-28T22:00:00Z'), Date.parse('2026-09-29T05:55:00Z'), TZ)).toBe(false)
  })
  it('a row made in band: yes (the route sent it from after())', () => {
    expect(bandSeenBetween(Date.parse('2026-09-28T20:30:00Z'), Date.parse('2026-09-28T22:00:00Z'), TZ)).toBe(true)
  })
  it('a row made overnight and read after 07:00: yes (an earlier in-band tick may have sent it)', () => {
    expect(bandSeenBetween(Date.parse('2026-09-28T22:00:00Z'), Date.parse('2026-09-29T06:10:00Z'), TZ)).toBe(true)
  })
  it('the read moment itself does not count (this tick has not sent yet)', () => {
    expect(bandSeenBetween(Date.parse('2026-09-28T22:00:00Z'), Date.parse('2026-09-29T06:00:00Z'), TZ)).toBe(false)
  })
  it('an unreadable instant says yes: assume it may have been told', () => {
    expect(bandSeenBetween(NaN, Date.parse('2026-09-29T05:00:00Z'), TZ)).toBe(true)
  })
})

describe('constants', () => {
  it('the via label and the swap close note are fixed strings (matched elsewhere)', () => {
    expect(REPLACE_VIA).toBe('replace')
    expect(REPLACE_SWAP_CLOSE_NOTE).toBe('Closed: a manager gave this shift to another coach.')
    // roster_change_log.details.reason on a replace undone before anyone was
    // told; roster-change-log.js passes it by value and the drawer reads it.
    expect(REPLACE_UNDONE_REASON).toBe('replace_undone')
  })
})
