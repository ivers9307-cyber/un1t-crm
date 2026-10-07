// HOST-EVENTS-PAGE.1 — pure helpers for the host's public page (/h/[slug]):
// which hero and accent to show, and the default wording. No IO.

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
