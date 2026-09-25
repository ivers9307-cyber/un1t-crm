// mobile/lib/calendar-feed-api.js
// ICSFEED.1 — the caller's OWN calendar link. Through api(), so the headers
// come from authHeaders() (CLAUDE.md: a hand-rolled Bearer drops
// x-impersonate-target, and the server refuses a link made while viewing as
// someone). No id parameter exists on the route, so none is sent.

import { api } from './api'

export function getMyCalendarFeed() {
  return api('/api/me/calendar-feed')
}

export function createMyCalendarFeed({ replace = false } = {}) {
  return api('/api/me/calendar-feed', { method: 'POST', body: { replace: replace === true } })
}

export function turnOffMyCalendarFeed() {
  return api('/api/me/calendar-feed', { method: 'DELETE' })
}
