// W0.9a — the in-studio TV clients' poll URL.
//
// FLEET-CMD.2 appends ?device=<fleet name> to the board's poll so the request
// doubles as the kiosk's render heartbeat on the token-gated
// /api/public/tv-live/[token] (W0.9a; the location-keyed entrypoint it also
// served went in W0.9c). One helper so the two clients (LiveTvClient,
// ChallengeTvClient) append it identically.

/**
 * @param {string} url            the poll endpoint, with or without a query
 * @param {string|null|undefined} device  from the page's ?device=, or null
 * @returns {string}
 */
export function withDevice(url, device) {
  if (!device) return url
  const sep = url.includes('?') ? '&' : '?'
  return `${url}${sep}device=${encodeURIComponent(device)}`
}
