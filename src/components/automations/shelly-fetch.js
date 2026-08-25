// SHELLY-UI.6 — the two things every Shelly panel does with a route.
//
// Split out of the components (the same way components/ui/styles.js is split
// out of the primitives) so all five of them read a failure the same way. A
// second copy of `j.error || 'Something went wrong'` in one panel is how one
// surface starts hiding the sentence the API worked hard to write.

/**
 * fetch + json, with NOTHING left to throw.
 *
 * A dropped connection resolves as `{ ok: false, status: 0, json: null }`
 * rather than rejecting, so no call site needs a try/catch to stay on screen
 * — which matters because the poll's whole contract is that a failed request
 * keeps the last good render. A 500 that answers HTML (a crashed route, a
 * proxy page) lands the same way: `json` is null and the caller falls back to
 * its own copy instead of exploding on a parse error.
 *
 * @returns {Promise<{ok: boolean, status: number, json: object|null}>}
 */
export async function fetchJson(url, init) {
  try {
    const res = await fetch(url, init)
    let json = null
    try {
      json = await res.json()
    } catch {
      // A body we cannot parse is not a body — see above.
    }
    return { ok: res.ok, status: res.status, json }
  } catch {
    // Network-level: offline laptop, aborted navigation. Status 0 is
    // distinguishable from every real HTTP answer.
    return { ok: false, status: 0, json: null }
  }
}

/**
 * The sentence to show for a failed (or pending) response body.
 *
 * The chain is the one the routes were written against:
 *   issues[0].message — validateBody's 400 shape puts the useful text here
 *                       and leaves `error` as the generic 'Invalid request'
 *   message           — the toggle's SUCCESS-but-pending bodies carry their
 *                       reassurance here (the card branches on `pending`
 *                       before it renders anything)
 *   error             — every failure body; the routes deliberately fold
 *                       their reassurance INTO this string rather than
 *                       parking it in a `message` nobody reads
 *
 * @param {object|null} json
 * @param {string} fallback  what to say when the body carried nothing usable
 *   (a network drop, an HTML error page)
 * @returns {string}
 */
export function errorText(json, fallback) {
  return json?.issues?.[0]?.message || json?.message || json?.error || fallback
}

/** Same JSON POST/PATCH shape at every call site. */
export function jsonBody(method, body) {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
}
