// mobile/lib/calendar-feed.js
// ICSFEED.1 — the Schedule tab's "Subscribe to my shifts" row: what it says
// and which link it hands the OS. Pure, so it is tested here (there is no RN
// component test runner). The server builds every URL; this only chooses.
//
// The link is shown ONCE (only its hash is stored), so it must never be lost
// to a silent hand-off. Opening a URL "succeeds" whenever any app takes it:
// on Android a browser always takes Google's add-by-URL page, which is a
// desktop-web flow that often does nothing useful on a phone. So the row never
// guesses: after making a link it offers a CHOICE (subscribeChoices) that
// always includes Share / copy of the https link, and keeps the link in hand
// for the rest of the session so the coach can come back to the choice.
//
// Why no Linking.canOpenURL: on iOS it answers false for any scheme missing
// from LSApplicationQueriesSchemes, and on Android 11+ for anything missing
// from <queries> — both native config an OTA cannot change. openURL needs
// neither; a throw falls back to the share sheet.

export const REPLACE_PROMPT = Object.freeze({
  title: 'Your calendar link',
  body: 'Make a new link to add your shifts on this phone? Calendars using your current link will stop updating.',
})

export const CHOOSE_PROMPT = Object.freeze({
  title: 'Add your shifts to a calendar',
  body: 'This link is shown once. If you lose it, make a new link (the old one stops). ' +
    'For Google Calendar, Share / copy the link and add it at calendar.google.com on a computer ("From URL") if the Google option does not work on this phone.',
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

/**
 * { title, subtitle, action: 'create' | 'manage' | 'choose' } for a GET
 * /api/me/calendar-feed status. `linkInHand`: a link made this session is
 * still held, so the row offers the choice again instead of "make a new one".
 */
export function feedRowModel(status, nowMs, { linkInHand = false } = {}) {
  if (linkInHand) {
    return {
      title: 'Add my shifts to a calendar',
      subtitle: 'Tap to open or share your new link. It is shown once: if you lose it, make a new one.',
      action: 'choose',
    }
  }
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
const HTTPS = /^https:\/\//

/**
 * The choices offered once a link exists, in order. `open` choices go to
 * Linking.openURL; the `share` choice hands the https link to the share sheet
 * (which has Copy on both platforms) and is ALWAYS last and always present
 * when there is an https link. Android gets two (an Alert holds three buttons
 * including Cancel); nothing but webcal:// or https:// ever reaches the OS.
 */
export function subscribeChoices(os, urls) {
  if (!urls) return []
  const apple = { key: 'apple', label: 'Apple Calendar', kind: 'open', url: urls.webcal_url }
  const calendar = { key: 'calendar', label: 'Calendar app', kind: 'open', url: urls.webcal_url }
  const google = { key: 'google', label: 'Google Calendar', kind: 'open', url: urls.google_url }
  const opens = os === 'ios' ? [apple, google] : os === 'android' ? [google] : [calendar, google]
  const out = opens.filter((c) => typeof c.url === 'string' && OPENABLE.test(c.url))
  if (typeof urls.url === 'string' && HTTPS.test(urls.url)) {
    out.push({ key: 'share', label: 'Share / copy link', kind: 'share', url: urls.url })
  }
  return out
}
