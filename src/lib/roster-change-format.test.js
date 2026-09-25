// src/lib/roster-change-format.test.js
// CHANGELOG.1 — one roster_change_log row as a sentence a manager can read.
// Pure. Host-TZ independent; run under both:
//   for tz in Europe/Dublin America/Los_Angeles UTC; do
//     TZ=$tz npx vitest run src/lib/roster-change-format.test.js
//   done
import { describe, it, expect } from 'vitest'
import {
  rosterChangeSentence, rosterChangeTold, rosterChangeByline,
  stampMeansTold, NO_MESSAGE_REASONS, ROSTER_CHANGE_LOG_MAX_ROWS,
} from './roster-change-format'

// Tue 15 Sep 2026. 13:02Z is 14:02 in Dublin (summer time, UTC+1).
const row = (over = {}) => ({
  id: 'c1', action: 'assigned', block_date: '2026-09-15', start_time: '06:00:00', end_time: '07:00:00',
  shift_name: 'Morning', coach_name: 'Coach A', actor_name: 'Manager B', details: {},
  notified_at: '2026-09-15T13:02:00Z', created_at: '2026-09-15T12:58:00Z', ...over,
})

describe('rosterChangeSentence', () => {
  it('assigned', () => {
    expect(rosterChangeSentence(row())).toBe('Assigned Coach A to Tue 15 Sep 6am')
  })

  it('unassigned', () => {
    expect(rosterChangeSentence(row({ action: 'unassigned' }))).toBe('Removed Coach A from Tue 15 Sep 6am')
  })

  it('says how it happened when the writer recorded it', () => {
    expect(rosterChangeSentence(row({ details: { via: 'copy_week' } }))).toBe('Assigned Coach A to Tue 15 Sep 6am (copied from another week)')
    expect(rosterChangeSentence(row({ details: { via: 'copy_month' } }))).toBe('Assigned Coach A to Tue 15 Sep 6am (copied from another month)')
    expect(rosterChangeSentence(row({ action: 'unassigned', details: { via: 'swap', swap_id: 's1', effect: 'approved_reassign' } })))
      .toBe('Removed Coach A from Tue 15 Sep 6am (shift swap)')
    expect(rosterChangeSentence(row({ action: 'unassigned', details: { via: 'swap_drop', swap_id: 's1' } })))
      .toBe('Removed Coach A from Tue 15 Sep 6am (dropped shift approved)')
  })

  it('REPLACE.1a — a replace names itself on both rows', () => {
    const base = { block_date: '2026-09-29', start_time: '06:00:00', details: { via: 'replace' } }
    expect(rosterChangeSentence({ ...base, action: 'assigned', coach_name: 'Coach B' }))
      .toBe('Assigned Coach B to Tue 29 Sep 6am (coach replaced)')
    expect(rosterChangeSentence({ ...base, action: 'unassigned', coach_name: 'Coach A' }))
      .toBe('Removed Coach A from Tue 29 Sep 6am (coach replaced)')
  })

  it('a deleted slot has no block left to read a time from: the date alone', () => {
    expect(rosterChangeSentence(row({ action: 'unassigned', start_time: null, end_time: null, details: { via: 'slot_deleted' } })))
      .toBe('Removed Coach A from Tue 15 Sep (slot deleted)')
  })

  it('time_changed from the assignment editor: the hours the coach now has', () => {
    expect(rosterChangeSentence(row({ action: 'time_changed', details: { start_time_override: '06:30:00', end_time_override: null } })))
      .toBe("Changed Coach A's hours on Tue 15 Sep 6am to 6:30am–7am")
  })

  it('time_changed with both overrides cleared is a reset', () => {
    expect(rosterChangeSentence(row({ action: 'time_changed', details: { start_time_override: null, end_time_override: null } })))
      .toBe("Reset Coach A's hours on Tue 15 Sep 6am to the shift's own")
  })

  it('time_changed from a template edit names the OLD time, because the block now holds the new one', () => {
    expect(rosterChangeSentence(row({
      action: 'time_changed', start_time: '06:30:00', end_time: '07:30:00',
      details: { source: 'template_edit', template_id: 't1', from: { start_time: '06:00:00', end_time: '07:00:00' }, to: { start_time: '06:30:00', end_time: '07:30:00' } },
    }))).toBe("Moved Coach A's Tue 15 Sep 6am shift to 6:30am–7:30am (template edited)")
  })

  it('time_changed with details it does not recognise still says something true', () => {
    expect(rosterChangeSentence(row({ action: 'time_changed', details: {} }))).toBe("Changed Coach A's hours on Tue 15 Sep 6am")
  })

  it('never invents a name, a date or an action', () => {
    expect(rosterChangeSentence(row({ coach_name: null }))).toBe('Assigned a coach to Tue 15 Sep 6am')
    expect(rosterChangeSentence(row({ block_date: null, start_time: null }))).toBe('Assigned Coach A to a shift')
    expect(rosterChangeSentence(row({ action: 'mystery' }))).toBe("Changed Coach A's shift on Tue 15 Sep 6am")
    expect(rosterChangeSentence(row({ details: { via: 'something_new' } }))).toBe('Assigned Coach A to Tue 15 Sep 6am')
    expect(rosterChangeSentence(row({ details: null }))).toBe('Assigned Coach A to Tue 15 Sep 6am')
  })

  it('reads the weekday off the calendar date, whatever the host timezone', () => {
    expect(rosterChangeSentence(row({ block_date: '2026-03-29' }))).toMatch(/Sun 29 Mar/) // spring DST day
    expect(rosterChangeSentence(row({ block_date: '2026-10-25' }))).toMatch(/Sun 25 Oct/) // autumn DST day
    expect(rosterChangeSentence(row({ block_date: '2026-12-14' }))).toMatch(/Mon 14 Dec/)
  })
})

describe('rosterChangeTold', () => {
  it('told, with the Dublin wall-clock time', () => {
    expect(rosterChangeTold(row())).toBe('told 14:02')
  })
  it('winter: Dublin is UTC, no shift', () => {
    expect(rosterChangeTold(row({ block_date: '2026-12-01', notified_at: '2026-12-01T14:02:00Z', created_at: '2026-12-01T09:00:00Z' }))).toBe('told 14:02')
  })
  it('names the day when the coach was told on a later day than the change', () => {
    expect(rosterChangeTold(row({ block_date: '2026-09-20', notified_at: '2026-09-17T08:05:00Z' }))).toBe('told 17 Sep 09:05')
  })
  it('a change at 23:30 Dublin told at 00:10 Dublin is a later DAY, even though UTC calls it the same day', () => {
    // 22:30Z = 23:30 Dublin on the 15th; 23:10Z = 00:10 Dublin on the 16th.
    expect(rosterChangeTold(row({ block_date: '2026-09-18', created_at: '2026-09-15T22:30:00Z', notified_at: '2026-09-15T23:10:00Z' }))).toBe('told 16 Sep 00:10')
  })
  it('not told yet', () => {
    expect(rosterChangeTold(row({ notified_at: null }))).toBe('not told yet')
  })
  it('an unreadable stamp is "told", never a crash or a made-up time', () => {
    expect(rosterChangeTold(row({ notified_at: 'garbage' }))).toBe('told')
  })
})

describe('rosterChangeByline', () => {
  it('who and when, in Dublin time', () => {
    expect(rosterChangeByline(row())).toBe('Manager B · 15 Sep 13:58')
  })
  it('a change with no actor (a deleted profile, or a system path) says so', () => {
    expect(rosterChangeByline(row({ actor_name: null }))).toBe('System · 15 Sep 13:58')
  })
  it('an unreadable created_at leaves the name alone', () => {
    expect(rosterChangeByline(row({ created_at: null }))).toBe('Manager B')
  })
})

describe('rosterChangeSentence — shift times read the way the calendar cards print them', () => {
  it('uses the 12-hour card form, minutes only when there are some', () => {
    expect(rosterChangeSentence(row({ start_time: '09:30:00' }))).toBe('Assigned Coach A to Tue 15 Sep 9:30am')
    expect(rosterChangeSentence(row({ start_time: '12:00:00' }))).toBe('Assigned Coach A to Tue 15 Sep 12pm')
    expect(rosterChangeSentence(row({ start_time: '17:15:00' }))).toBe('Assigned Coach A to Tue 15 Sep 5:15pm')
  })

  it('a time that is not a time is left out, never printed as NaN', () => {
    expect(rosterChangeSentence(row({ start_time: 'garbage' }))).toBe('Assigned Coach A to Tue 15 Sep')
    expect(rosterChangeSentence(row({ action: 'time_changed', details: { start_time_override: { x: 1 }, end_time_override: null } })))
      .toBe("Changed Coach A's hours on Tue 15 Sep 6am")
  })
})

describe('a row written because the staff member was deleted (mig 622)', () => {
  const deleted = (over = {}) => row({ action: 'unassigned', details: { reason: 'staff_permanent_delete' }, ...over })

  it('says why', () => {
    expect(rosterChangeSentence(deleted())).toBe('Removed Coach A from Tue 15 Sep 6am (staff member deleted)')
  })

  it('an unknown reason adds nothing', () => {
    expect(rosterChangeSentence(row({ action: 'unassigned', details: { reason: 'something_new' } }))).toBe('Removed Coach A from Tue 15 Sep 6am')
  })

  it('is stamped at once but nobody was told: no told state at all', () => {
    expect(NO_MESSAGE_REASONS).toContain('staff_permanent_delete')
    expect(stampMeansTold(deleted())).toBe(false)
    expect(rosterChangeTold(deleted())).toBeNull()
  })
})

describe('REPLACE.1a — a replace undone before anyone was told (the held-notice arm stamps it silently)', () => {
  const undone = (over = {}) => row({ action: 'unassigned', details: { via: 'replace', reason: 'replace_undone' }, ...over })

  it('says so, neutrally, in place of "(coach replaced)"', () => {
    expect(rosterChangeSentence(undone())).toBe('Removed Coach A from Tue 15 Sep 6am (changed again before anyone was told)')
  })

  it('its stamp is not a message: no told state', () => {
    expect(NO_MESSAGE_REASONS).toContain('replace_undone')
    expect(stampMeansTold(undone())).toBe(false)
    expect(rosterChangeTold(undone())).toBeNull()
  })
})

describe('REPLACE.1a review 3 — a replace whose shift started before its held notice could go out', () => {
  const started = (over = {}) => row({ action: 'assigned', details: { via: 'replace', reason: 'replace_shift_started' }, ...over })
  it('says so', () => {
    expect(rosterChangeSentence(started())).toBe('Assigned Coach A to Tue 15 Sep 6am (coach replaced, not sent: the shift had started)')
  })
  it('its stamp is not a message', () => {
    expect(NO_MESSAGE_REASONS).toContain('replace_shift_started')
    expect(rosterChangeTold(started())).toBeNull()
  })
})

describe('REPLACE.1a review 4 — a replace whose shift was deleted before its held notice went out', () => {
  const gone = (over = {}) => row({ action: 'assigned', start_time: null, end_time: null, details: { via: 'replace', reason: 'replace_shift_deleted' }, ...over })
  it('says so', () => {
    expect(rosterChangeSentence(gone())).toBe('Assigned Coach A to Tue 15 Sep (coach replaced, not sent: the shift was deleted)')
  })
  it('its stamp is not a message', () => {
    expect(NO_MESSAGE_REASONS).toContain('replace_shift_deleted')
    expect(rosterChangeTold(gone())).toBeNull()
  })
})

describe('stampMeansTold — a stamp is not always a message', () => {
  const future = { block_date: '2026-09-20' }

  it('an ordinary stamped row was told', () => {
    expect(stampMeansTold(row(future))).toBe(true)
    expect(stampMeansTold(row({ ...future, details: { via: 'swap', swap_id: 's1' } }))).toBe(true)
  })

  it('an approved drop on a DRAFT roster is stamped without a roster message', () => {
    const drop = (roster_status) => row({ ...future, action: 'unassigned', details: { via: 'swap_drop', roster_status } })
    expect(stampMeansTold(drop('draft'))).toBe(false)
    expect(rosterChangeTold(drop('draft'))).toBeNull()
    // An unreadable roster status is treated as a draft by the writer too.
    expect(stampMeansTold(drop(null))).toBe(false)
    expect(stampMeansTold(drop('published'))).toBe(true)
    expect(rosterChangeTold(drop('published'))).toBe('told 14:02')
  })

  it('a shift already over when the stamp was made: every writer stamps those without a message', () => {
    expect(stampMeansTold(row({ block_date: '2026-09-14' }))).toBe(false)
    expect(rosterChangeTold(row({ block_date: '2026-09-14' }))).toBeNull()
    // Same day is NOT over.
    expect(stampMeansTold(row({ block_date: '2026-09-15' }))).toBe(true)
  })

  it('"over" is judged on the DUBLIN day of the stamp, not the UTC one', () => {
    // 23:10Z on the 15th is 00:10 on the 16th in Dublin: the 15th is over.
    expect(stampMeansTold(row({ block_date: '2026-09-15', notified_at: '2026-09-15T23:10:00Z' }))).toBe(false)
    // 22:50Z on the 15th is 23:50 on the 15th in Dublin: it is not.
    expect(stampMeansTold(row({ block_date: '2026-09-15', notified_at: '2026-09-15T22:50:00Z' }))).toBe(true)
  })

  it('a coach who made the change themselves is stamped, and there was nobody to tell', () => {
    expect(stampMeansTold(row({ ...future, self_change: true }))).toBe(false)
    expect(rosterChangeTold(row({ ...future, self_change: true }))).toBeNull()
  })

  it('an unstamped row is still "not told yet", whatever else is true of it', () => {
    expect(rosterChangeTold(row({ notified_at: null, self_change: true }))).toBe('not told yet')
    expect(rosterChangeTold(row({ notified_at: null, details: { reason: 'staff_permanent_delete' } }))).toBe('not told yet')
  })
})

describe('the assignment editor\'s time change stamps ONLY on confirmed delivery', () => {
  // assignments/[id] PUT messages the coach with no past-date and no self
  // check, and stamps its row only when the push or email went out. So its
  // stamp always means told, even for yesterday's shift and even when the
  // manager edited their own hours. It writes exactly this shape.
  const edit = (over = {}) => row({
    action: 'time_changed', block_date: '2026-09-14', // the day BEFORE the stamp
    details: { start_time_override: '06:30:00', end_time_override: null }, ...over,
  })

  it('correcting yesterday\'s hours: the coach WAS told', () => {
    expect(stampMeansTold(edit())).toBe(true)
    expect(rosterChangeTold(edit())).toBe('told 14:02')
  })

  it('the same row unstamped is not told yet', () => {
    expect(rosterChangeTold(edit({ notified_at: null }))).toBe('not told yet')
  })

  it('a manager who edited their own hours was messaged too', () => {
    expect(rosterChangeTold(edit({ self_change: true }))).toBe('told 14:02')
    expect(rosterChangeTold(edit({ self_change: true, block_date: '2026-09-20' }))).toBe('told 14:02')
  })

  it('a reset (both overrides null) is the same writer', () => {
    expect(rosterChangeTold(edit({ details: { start_time_override: null, end_time_override: null } }))).toBe('told 14:02')
  })

  it('but a stamp made LATER is the re-publish safety net, which messages nobody about a shift already over', () => {
    // Delivery failed at edit time (row left unstamped), the shift passed, and
    // a re-publish two days on stamped it without a message.
    expect(rosterChangeTold(edit({ notified_at: '2026-09-17T08:05:00Z' }))).toBeNull()
    // The same late stamp for a shift still ahead DID come with a message.
    expect(rosterChangeTold(edit({ block_date: '2026-09-20', notified_at: '2026-09-17T08:05:00Z' }))).toBe('told 17 Sep 09:05')
  })

  it('only that writer\'s shape is exempt: a template edit or a plain assign is not', () => {
    const template = { source: 'template_edit', from: { start_time: '06:00:00', end_time: '07:00:00' }, to: { start_time: '06:30:00', end_time: '07:30:00' } }
    expect(rosterChangeTold(edit({ details: template }))).toBeNull()
    expect(rosterChangeTold(edit({ action: 'assigned' }))).toBeNull()
    expect(rosterChangeTold(edit({ details: { start_time_override: '06:30:00' } }))).toBeNull() // one key only: not what it writes
  })

  it('rules 1 and 2 still come first (no writer produces this mix; it is a guard, not a case)', () => {
    expect(rosterChangeTold(edit({ details: { start_time_override: null, end_time_override: null, reason: 'staff_permanent_delete' } }))).toBeNull()
  })
})

describe('ROSTER_CHANGE_LOG_MAX_ROWS', () => {
  it('lives here (client-safe) and is a whole number of pages', () => {
    expect(ROSTER_CHANGE_LOG_MAX_ROWS % 1000).toBe(0)
  })
})
// BLOCKEDIT.1
describe('rosterChangeSentence — block edits', () => {
  it("a coach moved by a shift edit reads like a template edit, labelled (shift edited)", () => {
    expect(rosterChangeSentence(row({
      action: 'time_changed', start_time: '07:00:00', end_time: '11:00:00',
      details: { source: 'block_edit', from: { start_time: '06:00:00', end_time: '10:00:00' }, to: { start_time: '07:00:00', end_time: '11:00:00' } },
    }))).toBe("Moved Coach A's Tue 15 Sep 6am shift to 7am–11am (shift edited)")
  })

  it('the coachless row lists what changed, naming the shift by its OLD time', () => {
    expect(rosterChangeSentence(row({
      action: 'block_edited', coach_name: null, start_time: '07:00:00',
      details: {
        source: 'block_edit',
        from: { start_time: '06:00:00', end_time: '10:00:00' }, to: { start_time: '07:00:00', end_time: '11:00:00' },
        min_coaches: { from: 1, to: 2 }, max_coaches: { from: 4, to: 3 }, briefing: 'added',
      },
    }))).toBe('Edited the Tue 15 Sep 6am Morning shift: times to 7am–11am, minimum 1 to 2, maximum 4 to 3, briefing added')
  })

  it('says only what it can read', () => {
    expect(rosterChangeSentence(row({ action: 'block_edited', details: { briefing: 'removed' } })))
      .toBe('Edited the Tue 15 Sep 6am Morning shift: briefing removed')
    expect(rosterChangeSentence(row({ action: 'block_edited', details: { min_coaches: { from: null, to: 2 } } })))
      .toBe('Edited the Tue 15 Sep 6am Morning shift')
    expect(rosterChangeSentence(row({ action: 'block_edited', block_date: null, details: {} })))
      .toBe('Edited a shift')
  })
})

describe('stampMeansTold — block edits', () => {
  it('a block_edited row has no told state: nobody is messaged about it', () => {
    const c = row({ action: 'block_edited', coach_name: null })
    expect(stampMeansTold(c)).toBe(false)
    expect(rosterChangeTold(c)).toBeNull()
  })

  it("a row the notice arm stamped without a message (notice: 'not_needed') has no told state", () => {
    const c = row({ action: 'time_changed', details: { source: 'block_edit', notice: 'not_needed' } })
    expect(stampMeansTold(c)).toBe(false)
  })

  it('a delivered block-edit notice is told', () => {
    const c = row({ action: 'time_changed', details: { source: 'block_edit', from: { start_time: '06:00:00', end_time: '10:00:00' }, to: { start_time: '07:00:00', end_time: '11:00:00' } } })
    expect(stampMeansTold(c)).toBe(true)
    expect(rosterChangeTold(c)).toBe('told 14:02')
  })
})
