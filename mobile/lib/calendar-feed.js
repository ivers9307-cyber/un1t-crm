// mobile/lib/calendar-feed.js
// ICSFEED.1 — the Schedule tab's "Subscribe to my shifts" row: what it says
// and which link it hands the OS. Pure, so it is tested here (there is no RN
// component test runner). The server builds every URL; this only chooses.
//
// Why no Linking.canOpenURL: on iOS it answers false for any scheme missing
// from LSApplicationQueriesSchemes, and on Android 11+ for anything missing
// from <queries> — both native config an OTA cannot change. openURL needs
// neither, so the row tries each link in order and falls back on a throw.

export const REPLACE_PROMPT = Object.freeze({
  title: 'Your calendar link',
  body: 'Make a new link to add your shifts on this phone? Calendars using your current link will stop updating.',
})

export const TURN_OFF_PROMPT = Object.freeze({
  title: 'Turn off your calendar link?',
  body: 'Your calendar will stop getting your shifts. You can make a new link any time.',
})

/** 'just now' | '12 min ago' | '3 h ago' | '3 days ago' | null */
export function lastSyncedLabel(iso, nowMs) {
  const t = Date.parse(iso ?? '')
  if (!Number.isFinite(t)) return null
  const mins = Math.round((nowMs - t) / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hours = Math.round(mins / 60)
  if (hours < 48) return `${hours} h ago`
  return `${Math.round(hours / 24)} days ago`
}

/** { title, subtitle, action: 'create' | 'manage' } for a GET /api/me/calendar-feed status. */
export function feedRowModel(status, nowMs) {
  if (status?.active !== true) {
    return { title: 'Subscribe to my shifts', subtitle: 'Add your published shifts to your calendar app.', action: 'create' }
  }
  const synced = lastSyncedLabel(status.last_fetched_at, nowMs)
  return {
    title: 'Calendar subscription on',
    subtitle: synced ? `Your calendar last checked ${synced}.` : 'Your calendar has not checked in yet.',
    action: 'manage',
  }
}

const OPENABLE = /^(webcal|https):\/\//

/** The links to try with Linking.openURL, in order. Only webcal:// and https:// ever reach the OS. */
export function subscribeOpenOrder(os, urls) {
  if (!urls) return []
  const order = os === 'ios'
    ? [urls.webcal_url]
    : os === 'android'
      ? [urls.google_url, urls.webcal_url]
      : [urls.webcal_url, urls.google_url]
  return order.filter((u) => typeof u === 'string' && OPENABLE.test(u))
}
