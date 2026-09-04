// RACEDAY.1 — tests for the wave / participant / portrait-layout helpers in
// shared/race-control.js. The timing helpers that live in the same module
// (formatElapsed, classifyBookingState, elapsedSecondsBetween,
// penaltySumSeconds, elapsedWithPenalties) are covered from the web side in
// src/lib/race-control.test.js, which imports them through the '@/lib'
// re-export — this file covers the helpers that file does not.
//
// Fixtures are the real shape from tomorrow's race: race_waves rows (mig 083,
// start_time is a Postgres TIME so it arrives 'HH:MM:SS') and team_members
// rows (name, role), including the solo entries whose team is named after the
// person.

import { describe, it, expect } from 'vitest'
import {
  waveDisplayLabel,
  waveSortKey,
  participantNames,
  shouldShowParticipants,
  portraitPanelFlex,
  canStartRace,
} from './race-control.js'

describe('waveDisplayLabel', () => {
  it('falls back to HH:MM when the wave has no label', () => {
    expect(waveDisplayLabel({ label: null, start_time: '10:30:00' })).toBe('10:30')
    expect(waveDisplayLabel({ label: undefined, start_time: '09:00:00' })).toBe('09:00')
    expect(waveDisplayLabel({ start_time: '14:45:00' })).toBe('14:45')
  })

  it('prefers the operator label when one is set', () => {
    expect(waveDisplayLabel({ label: 'Wave A', start_time: '10:30:00' })).toBe('Wave A')
    expect(waveDisplayLabel({ label: 'Elite Wave', start_time: '08:00:00' })).toBe('Elite Wave')
  })

  it('treats a whitespace-only label as unset and shows the time', () => {
    // An operator clearing the label field leaves ' ' behind; a blank badge
    // on the board is worse than the start time.
    expect(waveDisplayLabel({ label: '   ', start_time: '10:30:00' })).toBe('10:30')
    expect(waveDisplayLabel({ label: '', start_time: '10:30:00' })).toBe('10:30')
  })

  it('trims a padded label rather than rendering the padding', () => {
    expect(waveDisplayLabel({ label: '  Wave B  ', start_time: '11:00:00' })).toBe('Wave B')
  })

  it('accepts an already-sliced HH:MM start_time unchanged', () => {
    // The event form's <input type="time"> posts HH:MM, so a wave that came
    // straight back off a form payload is already 5 chars.
    expect(waveDisplayLabel({ label: null, start_time: '10:30' })).toBe('10:30')
  })

  it('returns null for a missing wave', () => {
    expect(waveDisplayLabel(null)).toBeNull()
    expect(waveDisplayLabel(undefined)).toBeNull()
  })

  it('returns null when there is neither a label nor a start time', () => {
    expect(waveDisplayLabel({})).toBeNull()
    expect(waveDisplayLabel({ label: null, start_time: null })).toBeNull()
    expect(waveDisplayLabel({ label: '  ', start_time: '  ' })).toBeNull()
  })
})

describe('waveSortKey', () => {
  const waveA = { id: 'w1', label: 'Wave A', start_time: '09:00:00' }
  const waveB = { id: 'w2', label: 'Wave B', start_time: '10:30:00' }
  const waveC = { id: 'w3', label: 'Wave C', start_time: '14:45:00' }

  it('orders real waves by start time', () => {
    expect(waveSortKey(waveA) < waveSortKey(waveB)).toBe(true)
    expect(waveSortKey(waveB) < waveSortKey(waveC)).toBe(true)
  })

  it('sorts a registration with NO wave last, not first', () => {
    // The regression this helper exists for: every call site wrote
    // `(wave?.start_time || '')`, and '' sorts BEFORE every real time, so an
    // unlinked registration jumped to the top of Next Up and read as the
    // team starting next.
    const rows = [
      { team: 'Tu Pac', wave: waveB },
      { team: 'Unassigned', wave: null },
      { team: 'Mark Murphy', wave: waveA },
      { team: 'Coach Gibbers', wave: waveC },
    ]
    const sorted = [...rows].sort((a, b) => waveSortKey(a.wave).localeCompare(waveSortKey(b.wave)))
    expect(sorted.map((r) => r.team)).toEqual(['Mark Murphy', 'Tu Pac', 'Coach Gibbers', 'Unassigned'])

    // And the same array under the old expression puts it first — pinned so
    // the two orderings can't be confused for each other again.
    const legacy = [...rows].sort((a, b) =>
      (a.wave?.start_time || '').localeCompare(b.wave?.start_time || ''),
    )
    expect(legacy[0].team).toBe('Unassigned')
  })

  it('sorts a wave-less row last with a plain > comparison too', () => {
    // Not just under localeCompare — some callers compare the keys directly.
    for (const wave of [waveA, waveB, waveC]) {
      expect(waveSortKey(null) > waveSortKey(wave)).toBe(true)
    }
  })

  it('sorts a wave whose start_time is missing or blank last as well', () => {
    // A joined wave row with no usable time is as unorderable as no wave.
    expect(waveSortKey({ id: 'w4', label: 'Broken' }) > waveSortKey(waveC)).toBe(true)
    expect(waveSortKey({ start_time: null }) > waveSortKey(waveC)).toBe(true)
    expect(waveSortKey({ start_time: '   ' }) > waveSortKey(waveC)).toBe(true)
  })

  it('orders a mixed-width payload by time, not by string length', () => {
    // HH:MM from the form, HH:MM:SS from Postgres — the board can hold both.
    expect(waveSortKey({ start_time: '09:00' }) < waveSortKey({ start_time: '10:30:00' })).toBe(true)
    expect(waveSortKey({ start_time: '10:30' })).toBe(waveSortKey({ start_time: '10:30:00' }))
  })

  it('always returns a string, so callers can localeCompare without guarding', () => {
    expect(typeof waveSortKey(waveA)).toBe('string')
    expect(typeof waveSortKey(null)).toBe('string')
    expect(typeof waveSortKey(undefined)).toBe('string')
    expect(typeof waveSortKey({})).toBe('string')
  })
})

describe('participantNames', () => {
  it('reads team_members rows in order', () => {
    const members = [
      { id: 'm1', name: 'Furlong', role: 'captain' },
      { id: 'm2', name: 'Graham Cullen', role: 'member' },
    ]
    expect(participantNames(members)).toEqual(['Furlong', 'Graham Cullen'])
  })

  it('trims surrounding whitespace', () => {
    expect(participantNames([{ name: '  Simon Gibney  ' }, { name: '\tAnn\n' }]))
      .toEqual(['Simon Gibney', 'Ann'])
  })

  it('drops blank and non-string names', () => {
    const members = [
      { id: 'm1', name: 'Mark Murphy' },
      { id: 'm2', name: '' },
      { id: 'm3', name: '   ' },
      { id: 'm4', name: null },
      { id: 'm5' },
      { id: 'm6', name: 42 },
      null,
      undefined,
    ]
    expect(participantNames(members)).toEqual(['Mark Murphy'])
  })

  it('de-duplicates case-insensitively, keeping the first spelling', () => {
    // Operator-entered rosters carry the same person twice often enough that
    // a 2-person team would otherwise print as 3 on the board.
    expect(participantNames([{ name: 'Ann' }, { name: 'ann' }, { name: 'ANN' }]))
      .toEqual(['Ann'])
    expect(participantNames([{ name: 'ann' }, { name: 'Ann' }]))
      .toEqual(['ann'])
  })

  it('de-duplicates across trimming too', () => {
    expect(participantNames([{ name: 'Ann' }, { name: '  ann  ' }])).toEqual(['Ann'])
  })

  it('preserves order while de-duplicating', () => {
    const members = [
      { name: 'Graham Cullen' },
      { name: 'Furlong' },
      { name: 'graham cullen' },
      { name: 'Simon Gibney' },
    ]
    expect(participantNames(members)).toEqual(['Graham Cullen', 'Furlong', 'Simon Gibney'])
  })

  it('accepts plain strings as well as rows', () => {
    expect(participantNames(['Mark Murphy', '  John  ', '', 'mark murphy']))
      .toEqual(['Mark Murphy', 'John'])
  })

  it('returns [] for a missing or non-array roster', () => {
    expect(participantNames(null)).toEqual([])
    expect(participantNames(undefined)).toEqual([])
    expect(participantNames([])).toEqual([])
    expect(participantNames('Mark Murphy')).toEqual([])
    expect(participantNames({ 0: 'Mark Murphy' })).toEqual([])
  })
})

describe('shouldShowParticipants', () => {
  it('hides a solo entry whose one name IS the team name', () => {
    expect(shouldShowParticipants('Mark Murphy', ['Mark Murphy'])).toBe(false)
  })

  it('hides a solo entry whose one name is a prefix of the team name', () => {
    // The common real shape: the team is registered under the full name and
    // the member row holds just the first name.
    expect(shouldShowParticipants("John O'Kane", ['John'])).toBe(false)
  })

  it('matches the team name case-insensitively', () => {
    expect(shouldShowParticipants('Mark Murphy', ['mark murphy'])).toBe(false)
    expect(shouldShowParticipants("john o'kane", ['JOHN'])).toBe(false)
    expect(shouldShowParticipants('Mark Murphy', ['  Mark  '])).toBe(false)
  })

  it('shows a solo entry whose name differs from the team name', () => {
    // A coach-branded team is a different person from its one participant.
    expect(shouldShowParticipants('Coach Gibbers', ['Simon Gibney'])).toBe(true)
  })

  it('shows every multi-person roster, however the team is named', () => {
    expect(shouldShowParticipants('Tu Pac', ['Furlong', 'Graham Cullen'])).toBe(true)
    // Even when the first name matches the team name — the second is new.
    expect(shouldShowParticipants('Mark Murphy', ['Mark Murphy', 'Ann'])).toBe(true)
  })

  it('shows nothing for an empty roster', () => {
    expect(shouldShowParticipants('Anything', [])).toBe(false)
    expect(shouldShowParticipants('Anything', null)).toBe(false)
    expect(shouldShowParticipants('Anything', undefined)).toBe(false)
    expect(shouldShowParticipants('Anything', [''])).toBe(false)
    expect(shouldShowParticipants('Anything', ['   '])).toBe(false)
  })

  it('shows the participant when the team has no usable name', () => {
    // Nothing to stutter against, and '(no team)' is what the card renders.
    expect(shouldShowParticipants('', ['Mark Murphy'])).toBe(true)
    expect(shouldShowParticipants(null, ['Mark Murphy'])).toBe(true)
    expect(shouldShowParticipants('   ', ['Mark Murphy'])).toBe(true)
  })

  it('keeps the longer member name when the TEAM name is the prefix', () => {
    // Deliberately one-directional: "John O'Kane" under team 'John' adds the
    // surname, so it is worth the second line. The reverse is the stutter.
    expect(shouldShowParticipants('John', ["John O'Kane"])).toBe(true)
  })

  it('suppresses a mid-word prefix — pinned, not accidental', () => {
    // The prefix test is literal, so a member genuinely called 'Mark' on a
    // team called 'Markus Doyle' is hidden. Recorded here so the behaviour is
    // visible rather than latent: the cost is one hidden name on a card whose
    // team name already reads as that person, and requiring a word boundary
    // would not change any real row on the board.
    expect(shouldShowParticipants('Markus Doyle', ['Mark'])).toBe(false)
  })
})

describe('portraitPanelFlex', () => {
  it('gives the whole height to the populated panel when the other is empty', () => {
    expect(portraitPanelFlex(7, 0)).toEqual({ active: 1, completed: 0 })
    expect(portraitPanelFlex(0, 3)).toEqual({ active: 0, completed: 1 })
  })

  it('gives both panels 0 when the board is empty', () => {
    // The caller renders two empty states; nothing to weight.
    expect(portraitPanelFlex(0, 0)).toEqual({ active: 0, completed: 0 })
  })

  it('splits proportionally when both panels are populated', () => {
    expect(portraitPanelFlex(3, 3)).toEqual({ active: 0.5, completed: 0.5 })
    // The partner panel is the REMAINDER (1 - active), not its own division,
    // which is what guarantees the pair sums to 1. On a non-terminating share
    // that costs an ulp — 1 - 2/3 is 0.33333333333333337, not 1/3 — so this
    // asserts closeness rather than identity. A flex weight is a layout
    // ratio; an ulp is invisible on the board and exact equality here would
    // be asserting IEEE-754, not the contract.
    const twoToOne = portraitPanelFlex(2, 1)
    expect(twoToOne.active).toBeCloseTo(2 / 3, 10)
    expect(twoToOne.completed).toBeCloseTo(1 / 3, 10)
    expect(twoToOne.active + twoToOne.completed).toBe(1)
  })

  it('clamps a lopsided split to 0.75 so neither panel collapses', () => {
    // 12 active vs 3 completed is 0.8 unclamped.
    expect(portraitPanelFlex(12, 3)).toEqual({ active: 0.75, completed: 0.25 })
    expect(portraitPanelFlex(1, 9)).toEqual({ active: 0.25, completed: 0.75 })
    expect(portraitPanelFlex(40, 1)).toEqual({ active: 0.75, completed: 0.25 })
  })

  it('always sums to 1 when both panels are populated', () => {
    for (const [a, c] of [[1, 1], [7, 3], [12, 3], [1, 9], [5, 2], [100, 1], [1, 100], [2, 7]]) {
      const flex = portraitPanelFlex(a, c)
      expect(flex.active + flex.completed).toBeCloseTo(1, 10)
      expect(flex.active).toBeGreaterThanOrEqual(0.25)
      expect(flex.active).toBeLessThanOrEqual(0.75)
      expect(flex.completed).toBeGreaterThanOrEqual(0.25)
      expect(flex.completed).toBeLessThanOrEqual(0.75)
    }
  })

  it('treats negative, NaN and non-numeric counts as empty rather than NaN flex', () => {
    // A bad count should fall back to an empty panel; a NaN flex collapses
    // the whole layout on the display board.
    expect(portraitPanelFlex(-3, 4)).toEqual({ active: 0, completed: 1 })
    expect(portraitPanelFlex(4, -3)).toEqual({ active: 1, completed: 0 })
    expect(portraitPanelFlex(NaN, 4)).toEqual({ active: 0, completed: 1 })
    expect(portraitPanelFlex(undefined, 4)).toEqual({ active: 0, completed: 1 })
    expect(portraitPanelFlex(null, null)).toEqual({ active: 0, completed: 0 })
    expect(portraitPanelFlex('x', 'y')).toEqual({ active: 0, completed: 0 })
    expect(portraitPanelFlex(Infinity, 4)).toEqual({ active: 0, completed: 1 })
  })

  it('accepts numeric strings the way a count off a payload arrives', () => {
    expect(portraitPanelFlex('3', '3')).toEqual({ active: 0.5, completed: 0.5 })
  })
})

describe('canStartRace', () => {
  // Mirrors POST /api/registrations/[id]/race-start, which 409s on anything
  // but `confirmed`. Live case this exists for: registration 8f714b71
  // ("Allen Thomson", 11:12 wave) was pending_payment in the 5 Sep field,
  // and the old flat Next Up list armed a Start button on it that the
  // server could only ever refuse.
  it('allows a confirmed registration', () => {
    expect(canStartRace({ status: 'confirmed' })).toBe(true)
  })

  it('refuses every status the route 409s on', () => {
    for (const status of ['pending_payment', 'pending', 'refunded', 'waitlisted', 'cancelled', 'no_show']) {
      expect(canStartRace({ status })).toBe(false)
    }
  })

  it('refuses a missing registration or a missing status rather than assuming', () => {
    expect(canStartRace(null)).toBe(false)
    expect(canStartRace(undefined)).toBe(false)
    expect(canStartRace({})).toBe(false)
  })
})
