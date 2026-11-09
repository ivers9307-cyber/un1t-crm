// HOSTPORTAL.4 — source-tagged share links for a host's event page. Each
// token is a plain utm_source word that event-attribution.js already accepts
// as a source and labels for Insights (event-share-links.test.js pins that),
// so a booking that came through "Copy a link for Instagram" is reported as
// Instagram even when an in-app browser drops the referrer.

export const SHARE_SOURCES = [
  { token: 'instagram', label: 'Instagram' },
  { token: 'whatsapp', label: 'WhatsApp' },
  { token: 'facebook', label: 'Facebook' },
  { token: 'tiktok', label: 'TikTok' },
  { token: 'x', label: 'X' },
  { token: 'linkedin', label: 'LinkedIn' },
]

// The QR code on a poster: its scans show up as their own source.
export const QR_SOURCE = 'qr'

/** `url` with utm_source=<source> set (replacing one; query and hash kept). Unparseable input comes back unchanged. */
export function taggedEventUrl(url, source) {
  try {
    const u = new URL(url)
    u.searchParams.set('utm_source', source)
    return u.toString()
  } catch {
    return url
  }
}
