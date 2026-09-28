// src/lib/glofox-settings-read.js
//
// REGISTRYREAD.1 — the one vocabulary for "this studio's Glofox settings
// could not be READ". It is NOT "Glofox is not configured here": a database
// blip must never tell staff to re-enter credentials, tell Mia the studio
// offers no booking, stamp a customer's booking failed, or tell a cron the
// studio has no Glofox.
//
// Lives in its own module (not glofox.js) on purpose: ~20 test suites mock
// '@/lib/glofox' with factories, and a constant exported from there would be
// undefined inside every one of them. Nothing mocks this file.

export const GLOFOX_SETTINGS_UNREADABLE = 'glofox_settings_unreadable'

export const GLOFOX_SETTINGS_UNREADABLE_MESSAGE =
  "Couldn't read this studio's Glofox settings just now (a temporary database error). Nothing was sent to Glofox. Try again in a minute."
