// PIPELINES.2 — board registry. The ONE place a pipelines.module string maps
// to code, so an unknown or retired module name is a caught, reported miss
// rather than a crashed cron.
//
// In shared/ because mobile cannot import src/lib and the mobile pipeline
// screen needs the taxonomy — the same reason pipeline-classifier.js is here.
// Import as 'shared/pipelines' from mobile, never a relative '../shared'.

import * as acquisition from './acquisition.js'
import * as acquisitionUn1t from './acquisition-un1t.js'
import * as paidTrial from './paid-trial.js'
import * as programmes from './programmes.js'
import * as paidTrialUn1t from './paid-trial-un1t.js'

export const BOARD_MODULES = Object.freeze({
  acquisition,
  acquisition_un1t: acquisitionUn1t,
  // PIPE3 — Stillorgan's two claim boards. Contacts-input (no inputSource):
  // the router (./router.js) decides who they see.
  paid_trial: paidTrial,
  programmes,
  // HATCH39 — the same €39 board, fed from un1t.online (Hatch Street).
  paid_trial_un1t: paidTrialUn1t,
})

export const PIPELINE_MODES = Object.freeze({ DERIVED: 'derived', MANUAL: 'manual' })

/**
 * Resolve a pipelines.module value to its board module.
 * @param {string|null} name
 * @returns {{stages: object[], requiredFields: string[], classify: Function}|null}
 */
export function getBoardModule(name) {
  if (!name || typeof name !== 'string') return null
  return Object.prototype.hasOwnProperty.call(BOARD_MODULES, name)
    ? BOARD_MODULES[name]
    : null
}
