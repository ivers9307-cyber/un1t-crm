// PIPE3.3 — the ONE placement authority for a studio running claim boards.
// Spec: docs/superpowers/specs/2026-10-31-stillorgan-three-pipelines-design.md
//
// A person sits on one board at a time. The nightly orchestrator
// (src/lib/pipeline-reclassify.js), the Glofox webhook path and the Cold route
// (ensureDealForContact in src/lib/glofox-sync.js) all call routeContact();
// a placement path that calls classifyContact() on its own for PLACEMENT is
// the PIPELINE-FLAP defect in a new costume (two writers, two answers, the
// deal drags back and forth overnight).
//
// Precedence (Richard, 31 Oct 2026, with the Gympass ruling mine):
//   1. Cold (a live dismissal) and Gympass → the acquisition board's pile.
//   2. A live €39 paid-trial claim → the €39 Trial board.
//   3. A live programme claim → the Programmes board.
//   4. Everyone else → the acquisition board, exactly classifyContact().
// A claim for a board the studio does not run is ignored, so a studio with the
// acquisition board alone behaves exactly as before this module existed.
//
// Pure, no IO. The claims come from src/lib/pipeline-claims.js.

import { classifyContact } from '../pipeline-classifier.js'
import { claimLive as paidClaimLive, classify as classifyPaid } from './paid-trial.js'
import { programmeClaimLive, classify as classifyProgramme } from './programmes.js'

export const BOARD_KEYS = Object.freeze({
  ACQUISITION: 'acquisition',
  PAID_TRIAL: 'paid_trial',
  PROGRAMMES: 'programmes',
})

/** The board modules that need claims loaded before they can place anyone. */
export const CLAIM_BOARD_MODULES = Object.freeze([BOARD_KEYS.PAID_TRIAL, BOARD_KEYS.PROGRAMMES])

// The acquisition piles that outrank every claim.
const OUTRANKS_CLAIMS = new Set(['cold_lead', 'gympass'])

/**
 * Which board, and which column, a contact belongs on.
 *
 * @param {object} contact   the contacts row (the union of the boards' requiredFields)
 * @param {{ paid?: object|null, programme?: { claimedAt:number }|null }|null} claims
 * @param {number} now       epoch ms
 * @param {Set<string>|null} boards  the board keys enabled at the studio
 * @returns {{ boardKey: string, slug: string }}
 */
export function routeContact(contact, claims, now = Date.now(), boards = null) {
  const acq = classifyContact(contact, now)
  const has = (key) => boards instanceof Set && boards.has(key)
  const paid = claims?.paid ?? null
  const programme = claims?.programme ?? null

  if (OUTRANKS_CLAIMS.has(acq)) return { boardKey: BOARD_KEYS.ACQUISITION, slug: acq }
  if (has(BOARD_KEYS.PAID_TRIAL) && paidClaimLive(paid, contact, now)) {
    return { boardKey: BOARD_KEYS.PAID_TRIAL, slug: classifyPaid(contact, now, paid) }
  }
  if (has(BOARD_KEYS.PROGRAMMES) && programmeClaimLive(programme, contact, now)) {
    return { boardKey: BOARD_KEYS.PROGRAMMES, slug: classifyProgramme(contact, now, programme) }
  }
  return { boardKey: BOARD_KEYS.ACQUISITION, slug: acq }
}
