// Build + OTA-update identity for the More-screen footer and crash screen.
//
// HARDENED (2026-06): the first version of this file did
// `import * as Updates from 'expo-updates'` at the top. A production
// OTA carrying it crashed on boot — the crash report's triggered queue
// was `expo.controller.errorRecoveryQueue`, i.e. the failure was in the
// expo-updates launch/error-recovery path. To take this module entirely
// out of that startup interaction surface:
//   - NO top-level expo-updates import (it's lazy-require'd inside a
//     try/catch, evaluated only when a function is actually called —
//     never at module-eval / app-launch time).
//   - every Updates access is guarded; any throw degrades to 'unknown'
//     instead of propagating.
// expo-constants is safe (used app-wide already) so it stays a normal
// import.

import Constants from 'expo-constants'

// Lazily + safely read the expo-updates module. Returns null if it
// can't be loaded or evaluated for any reason. Never throws.
function safeUpdates() {
  try {
    // eslint-disable-next-line global-require
    return require('expo-updates')
  } catch {
    return null
  }
}

// Read a single field off expo-updates without ever throwing.
function safeField(name, fallback = null) {
  try {
    const U = safeUpdates()
    if (!U) return fallback
    const v = U[name]
    return v === undefined ? fallback : v
  } catch {
    return fallback
  }
}

export function shortUpdateId() {
  const id = safeField('updateId')
  if (!id) return 'embedded'
  try { return String(id).slice(0, 8) } catch { return 'unknown' }
}

export function updateSource() {
  if (safeField('isEmbeddedLaunch') === true) return 'embedded'
  if (safeField('updateId')) return 'OTA'
  return 'embedded'
}

// One-line summary, e.g. "v1.2.0 · OTA 4f230b74 · production".
// Fully defensive — returns a best-effort string, never throws.
export function buildSummary() {
  let version = 'unknown'
  try { version = Constants.expoConfig?.version || 'unknown' } catch { /* ignore */ }
  const channel = safeField('channel') || 'dev'
  const idPart = updateSource() === 'OTA' ? `OTA ${shortUpdateId()}` : 'embedded'
  return `v${version} · ${idPart} · ${channel}`
}

export function buildDetails() {
  let appVersion = 'unknown'
  try { appVersion = Constants.expoConfig?.version || 'unknown' } catch { /* ignore */ }
  let createdAt = null
  try {
    const c = safeField('createdAt')
    createdAt = c ? new Date(c).toISOString() : null
  } catch { /* ignore */ }
  return {
    appVersion,
    runtimeVersion: safeField('runtimeVersion') || 'unknown',
    channel: safeField('channel') || 'dev',
    updateId: safeField('updateId') || null,
    source: updateSource(),
    createdAt,
  }
}
