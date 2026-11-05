// MIASETTINGS.2b — Mia's Off / Test / Live switch over the two stored flags.
// `enabled` + `test_mode` both true is LIVE FOR EVERYONE (the allowlist is not
// in effect), so it reads as 'live_and_test' and is shown as Live plus a warning.

export function statusOf({ enabled, test_mode } = {}) {
  if (enabled) return test_mode ? 'live_and_test' : 'live'
  return test_mode ? 'test' : 'off'
}

export function flagsFor(choice) {
  if (choice === 'live') return { enabled: true, test_mode: false }
  if (choice === 'test') return { enabled: false, test_mode: true }
  return { enabled: false, test_mode: false }
}
