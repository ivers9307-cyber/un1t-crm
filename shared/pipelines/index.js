// PIPELINES.2 — board registry. The ONE place a pipelines.module string maps
// to code, so an unknown or retired module name is a caught, reported miss
// rather than a crashed cron.
//
// In shared/ because mobile cannot import src/lib and the mobile pipeline
// screen needs the taxonomy — the same reason pipeline-classifier.js is here.
// Import as 'shared/pipelines' from mobile, never a relative '../shared'.

import * as acquisition from './acquisition.js'

export const BOARD_MODULES = Object.freeze({ acquisition })

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
