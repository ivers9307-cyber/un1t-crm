// Parse a scanned check-in QR. Phase B encodes each attendee's QR as the URL
//   {origin}/events/{eventId}/checkin/scan?t={signed-token}
// The in-app scanner only needs to pull {eventId, token} back out — the token
// is verified server-side (POST /api/events/{eventId}/checkin/scan), so this
// does no crypto. Returns null for anything that isn't one of our scan links.

const SCAN_PATH = /^\/events\/([^/]+)\/checkin\/scan\/?$/

export function parseCheckinQr(data) {
  if (typeof data !== 'string') return null
  let url
  try {
    url = new URL(data.trim())
  } catch {
    return null
  }
  const m = url.pathname.match(SCAN_PATH)
  if (!m) return null
  const eventId = m[1]
  const token = url.searchParams.get('t')
  if (!eventId || !token) return null
  return { eventId, token }
}
