// WRCPACK.1 — the pack's default period, pure and client-safe (the Reporting
// tab's card and the route both read it; src/lib/wrc-pack.js re-exports it
// and is server-only because of its reads).

/** The 12 months ending on `to`, inclusive: the same calendar day a year earlier, plus one day (29 Feb → 2 Mar). */
export function defaultWrcPeriod(to) {
  const [y, m, d] = to.split('-').map(Number)
  const from = new Date(Date.UTC(y - 1, m - 1, d + 1)).toISOString().slice(0, 10)
  return { from, to }
}
