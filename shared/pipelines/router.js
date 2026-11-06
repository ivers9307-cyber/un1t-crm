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
// PIPEBUILD.3g — offer boards (module `offer`, given as descriptors) slot into
// steps 2-3 by their own `priority`: after Cold/Gympass the router walks ONE
// ordered list of offer boards (priority; null or invalid = 100) with the €39
// board as an entry at priority 200 and Programmes at 300. Lower wins; at the
// same number an offer board goes before the €39/Programmes entry, then by key.
// With no offer board the list is exactly steps 2-3.
//
// Pure, no IO. The claims come from src/lib/pipeline-claims.js.

import { classifyContact } from '../pipeline-classifier.js'
import { claimLive as paidClaimLive, classify as classifyPaid } from './paid-trial.js'
import { programmeClaimLive, classify as classifyProgramme } from './programmes.js'
import { offerClaimLive, classify as classifyOffer } from './offer.js'

export const BOARD_KEYS = Object.freeze({
  ACQUISITION: 'acquisition',
  PAID_TRIAL: 'paid_trial',
  PROGRAMMES: 'programmes',
})

/** The board modules that need claims loaded before they can place anyone. */
export const CLAIM_BOARD_MODULES = Object.freeze([BOARD_KEYS.PAID_TRIAL, BOARD_KEYS.PROGRAMMES])

/** PIPEBUILD.3b — modules whose boards are configured offers, placed by priority (3g). */
export const OFFER_MODULES = Object.freeze(['offer'])

/** PIPEBUILD.3g — where an offer board without a usable priority sorts. */
export const OFFER_DEFAULT_PRIORITY = 100
/** PIPEBUILD.3g — the €39 and Programmes boards' places in the offer order. */
export const PAID_TRIAL_PRIORITY = 200
export const PROGRAMMES_PRIORITY = 300

// The acquisition piles that outrank every claim.
const OUTRANKS_CLAIMS = new Set(['cold_lead', 'gympass'])

const offerPriority = (p) => {
  if (p == null || p === '' || typeof p === 'boolean') return OFFER_DEFAULT_PRIORITY
  const n = Number(p)
  return Number.isFinite(n) ? n : OFFER_DEFAULT_PRIORITY
}
const byKey = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

/**
 * Which board, and which column, a contact belongs on.
 *
 * @param {object} contact   the contacts row (the union of the boards' requiredFields),
 *                           or a un1t.online pipeline snapshot (HATCH39)
 * @param {{ paid?: object|null, programme?: { claimedAt:number }|null }|null} claims
 * @param {number} now       epoch ms
 * @param {Set<string>|null} boards  the board KEYS enabled at the studio (pipelines.key:
 *                           'acquisition', 'paid_trial', 'programmes')
 * @param {{ classifyAcquisition?: Function }} [opts]  HATCH39 — the acquisition
 *   board's own classify (acquisition_un1t.classify carries TRIALDONE.2); it
 *   answers the Cold/Gympass check and the fallback. Default: classifyContact.
 * @returns {{ boardKey: string, slug: string }}
 */
export function routeContact(contact, claims, now = Date.now(), boards = null, { classifyAcquisition = classifyContact } = {}) {
  const acq = classifyAcquisition(contact, now)
  // `boards` is today's Set of board KEYS, or an array of descriptors
  // { key, module, board_type, priority, config } (PIPEBUILD.3b). Descriptors
  // normalise to the same key Set for the legacy branches below.
  const descriptors = Array.isArray(boards) ? boards.filter((d) => d && typeof d.key === 'string') : null
  const keys = descriptors ? new Set(descriptors.map((d) => d.key)) : boards
  const has = (key) => keys instanceof Set && keys.has(key)
  const paid = claims?.paid ?? null
  const programme = claims?.programme ?? null

  if (OUTRANKS_CLAIMS.has(acq)) return { boardKey: BOARD_KEYS.ACQUISITION, slug: acq }

  // PIPEBUILD.3g — one ordered walk: offer boards by priority, the €39 and
  // Programmes boards as fixed entries at 200 and 300 (offer first on a tie,
  // then key). Without descriptors there are no offer entries.
  const offers = claims?.offers instanceof Map ? claims.offers : null
  const entries = [
    { kind: 'paid', priority: PAID_TRIAL_PRIORITY, key: BOARD_KEYS.PAID_TRIAL },
    { kind: 'programmes', priority: PROGRAMMES_PRIORITY, key: BOARD_KEYS.PROGRAMMES },
  ]
  if (descriptors) {
    for (const d of descriptors) {
      if (d.board_type !== 'offer' || !OFFER_MODULES.includes(d.module)) continue
      entries.push({ kind: 'offer', priority: offerPriority(d.priority), key: d.key, d })
    }
  }
  entries.sort((a, b) => a.priority - b.priority
    || (a.kind === 'offer' ? 0 : 1) - (b.kind === 'offer' ? 0 : 1)
    || byKey(a.key, b.key))

  for (const e of entries) {
    if (e.kind === 'offer') {
      const d = e.d
      if (!offers || !d.config || !Array.isArray(d.config.stages)) continue
      const claim = offers.get(d.key) ?? null
      if (offerClaimLive(claim, contact, now, d.config)) {
        return { boardKey: d.key, slug: classifyOffer(contact, now, claim, d.config) }
      }
    } else if (e.kind === 'paid') {
      if (has(BOARD_KEYS.PAID_TRIAL) && paidClaimLive(paid, contact, now)) {
        return { boardKey: BOARD_KEYS.PAID_TRIAL, slug: classifyPaid(contact, now, paid) }
      }
    } else if (has(BOARD_KEYS.PROGRAMMES) && programmeClaimLive(programme, contact, now)) {
      return { boardKey: BOARD_KEYS.PROGRAMMES, slug: classifyProgramme(contact, now, programme) }
    }
  }
  return { boardKey: BOARD_KEYS.ACQUISITION, slug: acq }
}
