// CANDIDATES.1 — what the phone's coach pickers show. No RN runner: every
// decision the sheet makes is here.

import { describe, it, expect } from 'vitest'
import {
  NO_CANDIDATES, candidatesStarted, candidatesSettled, candidatesFor, candidatePickerView, CANDIDATE_TONE_CLASS,
} from './candidates-view'
import { CANDIDATES_RANKING_NOTE, CANDIDATES_UNRANKED_NOTE } from 'shared/candidates'

const LOC = 'loc1'
const block = { id: 'b1', shift_assignments: [{ profile_id: 'on', status: 'scheduled' }] }
const staff = [
  { id: 'zed', full_name: 'Zed', role: 'staff', active: true, profile_locations: [{ location_id: LOC }] },
  { id: 'amy', full_name: 'Amy', role: 'manager', active: true, profile_locations: [{ location_id: LOC }] },
  { id: 'on', full_name: 'On Already', role: 'staff', active: true, profile_locations: [{ location_id: LOC }] },
]
const RANKED = { success: true, data: { audience: 'manager', checked: { shifts: true, leave: false }, untimed: 0, candidates: [
  { profile_id: 'amy', full_name: 'Amy', role: 'manager', rank: 2, tier: 'blocked', reason: 'Working 9am–11am Class' },
  { profile_id: 'zed', full_name: 'Zed', role: 'staff', rank: 1, tier: 'ready', reason: 'Free · 4h of 39h this week' },
] } }

describe('the request lifecycle', () => {
  it('only the answer to the CURRENT request for the CURRENT block lands', () => {
    const started = candidatesStarted('b1', 1)
    expect(started).toEqual({ blockId: 'b1', requestId: 1, answer: null, pending: true })
    expect(candidatesFor(started, 'b1')).toEqual({ candidates: null, candidatesPending: true })

    const settled = candidatesSettled(started, { blockId: 'b1', requestId: 1, res: RANKED })
    expect(settled.pending).toBe(false)
    expect(settled.answer).toMatchObject({ ok: true, audience: 'manager' })
    expect(candidatesFor(settled, 'b1').candidates.candidates.map((c) => c.profile_id)).toEqual(['zed', 'amy'])

    // A slower, older answer (request 1) after the sheet re-opened (request 2).
    const reopened = candidatesStarted('b1', 2)
    expect(candidatesSettled(reopened, { blockId: 'b1', requestId: 1, res: RANKED })).toBe(reopened)
    // An answer for another block.
    expect(candidatesSettled(started, { blockId: 'b9', requestId: 1, res: RANKED })).toBe(started)
    // Asked about another block, or with nothing open.
    expect(candidatesFor(settled, 'b9')).toEqual({ candidates: null, candidatesPending: false })
    expect(candidatesFor(NO_CANDIDATES, null)).toEqual({ candidates: null, candidatesPending: false })
  })

  it('a transport envelope or a server error settles as failed', () => {
    const s = candidatesSettled(candidatesStarted('b1', 1), { blockId: 'b1', requestId: 1, res: { success: false, transport: true, error: 'Network error' } })
    expect(s.answer).toEqual({ ok: false, reason: 'failed' })
  })
})

describe('candidatePickerView', () => {
  const answerOf = (res) => candidatesSettled(candidatesStarted('b1', 1), { blockId: 'b1', requestId: 1, res }).answer

  it('ranked: the server order, the reason line and its tone; what was not checked', () => {
    const view = candidatePickerView({ answer: answerOf(RANKED), staff: null, block, locationId: LOC, error: 'The coach list could not be loaded.' })
    expect(view.ranked).toBe(true)
    expect(view.rows).toEqual([
      { id: 'zed', full_name: 'Zed', role: 'staff', reason: 'Free · 4h of 39h this week', tone: 'good' },
      { id: 'amy', full_name: 'Amy', role: 'manager', reason: 'Working 9am–11am Class', tone: 'bad' },
    ])
    expect(view.note).toBe('Could not check leave, so the order may be off.')
    // A ranked answer rescues a failed staff list.
    expect(view.error).toBeNull()
    expect(view.waiting).toBe(false)
  })

  it('a colleague sees free or working', () => {
    const res = { success: true, data: { audience: 'colleague', checked: { shifts: true }, candidates: [
      { profile_id: 'zed', full_name: 'Zed', role: 'staff', rank: 1, tier: 'ready', reason: 'Free then', free: true },
    ] } }
    expect(candidatePickerView({ answer: answerOf(res), staff, block, locationId: LOC }).rows[0])
      .toEqual({ id: 'zed', full_name: 'Zed', role: 'staff', reason: 'Free then', tone: 'good' })
  })

  // CANDIDATES.1 review 2 — the server words a free colleague "Free here then"
  // when the other studios could not be read; the sheet shows it verbatim.
  it('the other studios unchecked: the reason says "here", and the note says why', () => {
    const res = { success: true, data: { audience: 'colleague', checked: { shifts: true, cross_studio: false }, candidates: [
      { profile_id: 'zed', full_name: 'Zed', role: 'staff', rank: 1, tier: 'ready', reason: 'Free here then', free: true },
    ] } }
    const view = candidatePickerView({ answer: answerOf(res), staff, block, locationId: LOC })
    expect(view.rows[0].reason).toBe('Free here then')
    expect(view.note).toBe('Could not check the other studios, so the order may be off.')
  })

  it('while ranking: the studio A–Z (never the coach already on it), labelled', () => {
    const view = candidatePickerView({ answer: null, pending: true, staff, block, locationId: LOC })
    expect(view.rows.map((r) => r.id)).toEqual(['amy', 'zed'])
    expect(view.rows[0]).toEqual({ id: 'amy', full_name: 'Amy', role: 'manager', reason: null, tone: null })
    expect(view.note).toBe(CANDIDATES_RANKING_NOTE)
    expect(view.waiting).toBe(false)
  })

  it('failed or unrecognised: A–Z with the note (nothing was checked); never asked: A–Z in silence', () => {
    expect(candidatePickerView({ answer: answerOf({ success: false }), staff, block, locationId: LOC }).note).toBe(CANDIDATES_UNRANKED_NOTE)
    expect(candidatePickerView({ answer: answerOf({ success: true, data: [] }), staff, block, locationId: LOC }).note).toBe(CANDIDATES_UNRANKED_NOTE)
    // No ask at all (a dashboard row from before block_id): the old sheet.
    expect(candidatePickerView({ answer: null, staff, block, locationId: LOC }).note).toBeNull()
  })

  it('waits (spinner) while nothing can be shown yet, and passes a staff error through only without a ranking', () => {
    expect(candidatePickerView({ answer: null, pending: true, staff: null, block, locationId: LOC }).waiting).toBe(true)
    expect(candidatePickerView({ answer: null, loading: true, staff: null, block, locationId: LOC }).waiting).toBe(true)
    const failed = candidatePickerView({ answer: answerOf({ success: false }), staff: null, block, locationId: LOC, error: 'boom' })
    expect(failed).toMatchObject({ waiting: false, error: 'boom', rows: [] })
  })

  it('tones map to readable -700 text on the light theme', () => {
    expect(CANDIDATE_TONE_CLASS).toEqual({ good: 'text-emerald-700', warn: 'text-amber-700', bad: 'text-red-700', muted: 'text-un1t-subtle' })
  })
})
