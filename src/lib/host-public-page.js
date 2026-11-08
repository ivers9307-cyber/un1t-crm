// HOST-EVENTS-PAGE.1 — pure helpers for the host's public page (/h/[slug]):
// which hero and accent to show, and the default wording. No IO.

import { orderEventsForBrowse } from '@shared/events'

const HEX = /^#[0-9a-fA-F]{6}$/

function cleanUrl(v) {
  const s = typeof v === 'string' ? v.trim() : ''
  return /^https?:\/\//i.test(s) ? s : null
}

/**
 * The host's own hero/accent win; otherwise the hero of the FIRST event in
 * `events` (callers pass them nearest-first) that has one. Accent falls back
 * the same way, then to null (neutral styling).
 * @returns {{ heroUrl: string|null, accentHex: string|null }}
 */
export function pickHostBranding(host, events = []) {
  let heroUrl = cleanUrl(host?.hero_image_url)
  let accentHex = HEX.test(String(host?.accent_hex || '').trim()) ? host.accent_hex.trim() : null
  for (const e of Array.isArray(events) ? events : []) {
    if (heroUrl && accentHex) break
    if (!heroUrl) heroUrl = cleanUrl(e?.hero_image_url)
    if (!accentHex && HEX.test(String(e?.accent_hex || '').trim())) accentHex = e.accent_hex.trim()
  }
  return { heroUrl, accentHex }
}

/** Operator copy with defaults (customer-facing copy is operator-editable). */
export function hostPageCopy(host) {
  const headline = String(host?.events_headline || '').trim()
  const blurb = String(host?.events_blurb || '').trim()
  return {
    headline: headline || 'Upcoming events',
    blurb: blurb || null,
  }
}

/**
 * HOST-EVENTS-PAGE.2 — the events a host's public page lists, nearest first:
 * every one dated `today` (YYYY-MM-DD, the host anchor studio's day, TZ.9) or later, INCLUDING
 * those whose registration window has closed (the card says "Registration
 * closed" and does not link to the buy page). Past events are dropped.
 */
export function hostPageEvents(rows, today) {
  return orderEventsForBrowse(rows, today).upcoming
}

/** Social previews for either host page. `path` is the full public page URL;
 * `page` is 'events' or 'join'; events arrive upcoming and nearest-first.
 */
export function hostPageMetadata({ host, events, orgName, path, page }) {
  const join = page === 'join'
  const headline = join ? host.list_headline : host.events_headline
  const title = headline
    ? `${headline} — ${host.name}`
    : `${host.name} — ${join ? 'join the list' : 'upcoming events'}`
  const description = (join ? null : host.events_blurb) || host.list_blurb || (join
    ? `Get emails about ${host.name}'s events. Unsubscribe anytime.`
    : `Book ${host.name}'s upcoming events.`)
  const { heroUrl } = pickHostBranding(host, events)
  return {
    title,
    description,
    openGraph: {
      title,
      description,
      siteName: orgName,
      type: 'website',
      url: path,
      ...(heroUrl ? { images: [{ url: heroUrl }] } : {}),
    },
    twitter: { card: 'summary_large_image' },
  }
}

/**
 * HOSTSERIES.1 — cards grouped under their series: the one-offs first (in
 * the order given, which is date order), then each series in order of its
 * first date. `makeCard(row)` builds the card. A row with no series goes in
 * the null group; no one-offs means no null group.
 * @returns {Array<{ seriesName: string|null, seriesSlug: string|null, cards: Array }>}
 */
export function groupHostCards(rows, makeCard) {
  const groups = new Map()
  const firstDate = new Map()
  for (const row of Array.isArray(rows) ? rows : []) {
    const key = row?.series_id && row?.series ? row.series.id : null
    if (!groups.has(key)) groups.set(key, { seriesName: key ? row.series.name : null, seriesSlug: key ? row.series.slug : null, cards: [] })
    groups.get(key).cards.push(makeCard(row))
    const d = String(row?.race_date || '')
    if (!firstDate.has(key) || d < firstDate.get(key)) firstDate.set(key, d)
  }
  const out = []
  if (groups.has(null)) out.push(groups.get(null))
  const series = [...groups.entries()].filter(([key]) => key !== null)
  series.sort((a, b) => firstDate.get(a[0]).localeCompare(firstDate.get(b[0])))
  for (const [, g] of series) out.push(g)
  return out
}
