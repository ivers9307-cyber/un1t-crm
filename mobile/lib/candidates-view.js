// CANDIDATES.1 — what the phone's coach pickers show: Manage mode's "Add
// coach" sheet and Today's "Ask a coach to cover" sheet (both
// CoachPickerSheet). Pure, tested in candidates-view.test.js: there is no
// React Native component runner, so every decision the sheet makes is here.
//
// The ranked answer is GET /api/schedule/blocks/[id]/candidates (via
// getBlockCandidates). Until it lands, or when it fails or is not understood,
// the sheet shows what it showed before CANDIDATES.1: the studio's staff A–Z
// (filterAssignableCoaches), labelled so it is not read as a ranking or an
// all-clear. Every row stays pickable; nothing here blocks.

import {
  parseCandidatesAnswer, candidateTone, candidatesUncheckedNote,
  CANDIDATES_RANKING_NOTE, CANDIDATES_UNRANKED_NOTE,
} from 'shared/candidates'
import { filterAssignableCoaches } from './schedule-manage'

export const CANDIDATE_TONE_CLASS = Object.freeze({
  good: 'text-emerald-700',
  warn: 'text-amber-700',
  bad: 'text-red-700',
  muted: 'text-un1t-subtle',
})

export const NO_CANDIDATES = Object.freeze({ blockId: null, requestId: 0, answer: null, pending: false })

/** A new ask for `blockId`; `requestId` is the caller's counter. */
export function candidatesStarted(blockId, requestId) {
  return { blockId: blockId ?? null, requestId, answer: null, pending: Boolean(blockId) }
}

/**
 * Land an api() result, but only for the request still current: a slow older
 * answer (the sheet re-opened) or one for another block leaves state alone.
 */
export function candidatesSettled(state, { blockId, requestId, res }) {
  if (!state || state.blockId !== blockId || state.requestId !== requestId) return state
  return { ...state, answer: parseCandidatesAnswer(res), pending: false }
}

/** The sheet's props for the block it is open on. */
export function candidatesFor(state, blockId) {
  if (!blockId || state?.blockId !== blockId) return { candidates: null, candidatesPending: false }
  return { candidates: state.answer, candidatesPending: Boolean(state.pending) }
}

/**
 * @returns {{ ranked: boolean, note: string|null, waiting: boolean, error: string|null,
 *   rows: Array<{ id, full_name, role, reason: string|null, tone: string|null }> }}
 */
export function candidatePickerView({ answer = null, pending = false, staff, block, locationId, loading = false, error = null }) {
  if (answer?.ok) {
    return {
      ranked: true,
      note: candidatesUncheckedNote(answer.checked),
      waiting: false,
      error: null,
      rows: answer.candidates.map((c) => ({
        id: c.profile_id,
        full_name: c.full_name || 'Coach',
        role: c.role ?? null,
        reason: c.reason ?? null,
        tone: candidateTone(c),
      })),
    }
  }
  const rows = filterAssignableCoaches(staff || [], block, locationId)
    .map((s) => ({ id: s.id, full_name: s.full_name, role: s.role ?? null, reason: null, tone: null }))
  return {
    ranked: false,
    // Failed and unrecognised read the same: nothing was checked, so say so.
    // No answer at all (never asked, e.g. a row with no block id) is silent.
    note: pending ? CANDIDATES_RANKING_NOTE : answer ? CANDIDATES_UNRANKED_NOTE : null,
    waiting: (loading && staff == null) || (pending && rows.length === 0),
    error: error || null,
    rows,
  }
}
