// mobile/lib/widget-tokens-api.js
// WIDGET.1 — mobile-side wrapper for the widget-credential routes. These are
// SESSION-only routes (src/app/api/widget/tokens/*) — the widget extension
// itself never calls them; only this screen, while the staff member is signed
// into the app, does.

import { api } from './api'

export function listWidgetTokens() {
  return api('/api/widget/tokens')
}

export function mintWidgetToken(locationId, deviceLabel) {
  return api('/api/widget/tokens', {
    method: 'POST',
    locationId,
    body: deviceLabel ? { device_label: deviceLabel } : {},
  })
}

export function revokeWidgetToken(tokenId) {
  return api(`/api/widget/tokens/${tokenId}`, { method: 'DELETE' })
}

export function listWidgetDevices(locationId) {
  return api('/api/widget/devices', { locationId })
}
