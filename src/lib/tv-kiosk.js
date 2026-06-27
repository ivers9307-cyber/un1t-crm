// Pure helpers for the studio-TV kiosk mode. No DOM/IO.

/** Is the page in kiosk mode? Parses `?kiosk=1` from a location.search string. */
export function isKioskParam(search) {
  try { return new URLSearchParams(search || '').get('kiosk') === '1' } catch { return false }
}

/** Show the "reconnecting" indicator once consecutive poll failures reach the threshold. */
export function showReconnecting({ consecutiveFailures, threshold = 2 } = {}) {
  return (Number(consecutiveFailures) || 0) >= threshold
}
