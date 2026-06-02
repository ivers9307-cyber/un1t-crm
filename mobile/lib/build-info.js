// Build + OTA-update identity, surfaced so anyone can answer
// "what version / which OTA bundle is this device running?" at a glance.
//
// Why this exists: a bad EAS Update once hung the app on the splash
// screen with no way to tell whether a device had pulled the latest
// OTA. This module reads the running update's identity from
// expo-updates + the app version from expo-constants so the More
// screen (and the crash screen) can display it. Pure reads — no
// side effects, safe to call anywhere.

import * as Updates from 'expo-updates'
import Constants from 'expo-constants'

// Short, human-comparable id for the running update. In Expo Go / dev
// (or a build with no OTA applied) updateId is null — we show "embedded"
// so it's clear the device is on the binary's bundled JS, not an OTA.
export function shortUpdateId() {
  const id = Updates.updateId
  if (!id) return 'embedded'
  return id.slice(0, 8)
}

// Where the JS came from: an applied OTA update vs the binary's
// embedded bundle. Mirrors Updates.isEmbeddedLaunch when available.
export function updateSource() {
  if (Updates.isEmbeddedLaunch === true) return 'embedded'
  if (Updates.updateId) return 'OTA'
  return 'embedded'
}

// One-line summary for the footer, e.g. "v1.2.0 · OTA 4f230b74 · production".
export function buildSummary() {
  const version = Constants.expoConfig?.version || 'unknown'
  const channel = Updates.channel || 'dev'
  const src = updateSource()
  const id = shortUpdateId()
  const idPart = src === 'OTA' ? `OTA ${id}` : 'embedded'
  return `v${version} · ${idPart} · ${channel}`
}

// Full structured detail for a diagnostics view / crash screen.
export function buildDetails() {
  return {
    appVersion: Constants.expoConfig?.version || 'unknown',
    runtimeVersion: Updates.runtimeVersion || 'unknown',
    channel: Updates.channel || 'dev',
    updateId: Updates.updateId || null,
    source: updateSource(),
    createdAt: Updates.createdAt ? new Date(Updates.createdAt).toISOString() : null,
  }
}
