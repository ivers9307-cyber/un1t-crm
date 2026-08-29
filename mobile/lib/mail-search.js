// MOBILE-MAIL-SEARCH.1 — every decision the mail-search screen makes, as a
// pure module. The screen (app/(staff)/email/search.jsx) owns a TextInput and
// a FlatList and nothing else: mobile screens have no render harness under
// vitest, so any branch that lived in the JSX would ship untested (the
// jsdom-cannot-see-layout lesson, restated for RN). Three rule families:
//
//   1. THE DEBOUNCE MACHINE — when a keystroke becomes a request, which
//      response is allowed to land, and what a failure reads as. The traps it
//      exists to hold shut:
//        • a stale response landing after a newer one (type fast on a slow
//          connection and the FIRST request can resolve LAST — without the
//          sequence guard the older, wronger result set wins);
//        • a cleared search whose in-flight response then paints ghost rows;
//        • a failed search wearing an empty state's clothes — the house rule
//          (mockup §06): phase 'error' is its own state, never rows:[].
//   2. THE SCOPE LINE — the honest statement of what was searched. The mail
//      route scans EVERY view when it is handed q with no view param (the
//      web surface rides the same engine), and when its scan truncates it
//      says so via search_partial; this line repeats both facts instead of
//      pretending completeness.
//   3. HIGHLIGHT SPLITTING — which characters of a subject get the ink mark
//      (mockup §03). Display-only: it never influences what matched — the
//      server's websearch FTS decided that — it only shows WHY a row is
//      probably here. Longest-term-first so overlapping terms mark the fuller
//      word, and the query is escaped so a member who types "(approx.)" is
//      searching for text, not writing a regex.
//
// No React, no React-Native, no ./api import anywhere in this file: the
// search function is injected, which is what lets the whole lifecycle run
// under fake timers in mail-search.test.js.

// Matches the approved spec (300ms). Web debounces at 350; the difference is
// deliberate — a phone keyboard is slower per keystroke, so the window can be
// tighter without doubling request volume.
export const SEARCH_DEBOUNCE_MS = 300

/**
 * The one state shape the screen renders from.
 * phase: 'idle'      — blank query, nothing to show
 *        'searching' — a request is in flight (rows = the PREVIOUS results,
 *                      kept so a refinement doesn't blank the list)
 *        'results'   — rows are the answer for `query`
 *        'error'     — the search failed; rows are still the previous results
 */
export function initialSearchState() {
  return { query: '', phase: 'idle', rows: [], searchPartial: false, error: null }
}

/**
 * The debounce + request-lifecycle machine.
 *
 * @param {object} opts
 * @param {(q: string) => Promise<{success: boolean, data?: object[],
 *   searchPartial?: boolean, error?: string}>} opts.search  usually
 *   `q => listMail(locationId, { q })` — NO view param, so the route scans
 *   every view, which is what the scope line then states.
 * @param {(state: object) => void} [opts.onState]  called on every change
 * @param {number} [opts.debounceMs]
 * @returns {{ setQuery(text: string): void, retry(): void,
 *             dispose(): void, getState(): object }}
 */
export function createMailSearchController({ search, onState, debounceMs = SEARCH_DEBOUNCE_MS } = {}) {
  let state = initialSearchState()
  let timer = null
  // Bumped for every issued request AND every clear. A response may only
  // land while its own number is still current — this single counter is both
  // the stale-response guard and the ghost-rows-after-clear guard.
  let seq = 0
  // Disposal is ITS OWN mechanism, deliberately not a seq bump: it gates the
  // entry points (setQuery/retry) and the response handlers, so nothing runs,
  // lands, or emits after the screen is gone. One mechanism per rule — the
  // first cut had three overlapping ones and mutation testing showed two of
  // them were dead weight.
  let disposed = false
  // The trimmed query most recently scheduled, run, or cleared. Re-setting an
  // identical query is a no-op (an inert trailing space must not re-fire the
  // search), but clearing resets this so retyping the same words works.
  let lastQuery = ''

  const emit = (patch) => {
    state = { ...state, ...patch }
    if (onState) onState(state)
  }

  const run = (q) => {
    const mySeq = ++seq
    // Previous rows deliberately kept — see the state shape above.
    emit({ query: q, phase: 'searching' })
    // search() is invoked SYNCHRONOUSLY (the debounce already provided the
    // delay); the try/catch turns a synchronously-throwing search into the
    // same rejected promise a network failure produces.
    let pending
    try {
      pending = Promise.resolve(search(q))
    } catch (err) {
      pending = Promise.reject(err)
    }
    pending
      .then((res) => {
        if (disposed || mySeq !== seq) return
        if (res && res.success) {
          emit({
            phase: 'results',
            rows: res.data || [],
            searchPartial: !!res.searchPartial,
            error: null,
          })
        } else {
          // rows untouched: the operator keeps the context they had.
          emit({ phase: 'error', error: (res && res.error) || 'The search failed.' })
        }
      })
      .catch(() => {
        if (disposed || mySeq !== seq) return
        emit({ phase: 'error', error: 'The search failed.' })
      })
  }

  return {
    getState: () => state,

    setQuery(text) {
      if (disposed) return
      const q = String(text ?? '').trim()
      if (q === lastQuery) return
      lastQuery = q
      if (timer) { clearTimeout(timer); timer = null }
      if (!q) {
        seq += 1 // invalidate anything in flight — its response must not land
        emit(initialSearchState())
        return
      }
      timer = setTimeout(() => { timer = null; run(q) }, debounceMs)
    },

    /** Re-run the current query NOW — the error state's second chance.
     *  No debounce: the operator asked explicitly. */
    retry() {
      if (disposed || !lastQuery) return
      if (timer) { clearTimeout(timer); timer = null }
      run(lastQuery)
    },

    dispose() {
      disposed = true
      if (timer) { clearTimeout(timer); timer = null }
    },
  }
}

// ── Scope line (mockup §03, callout 2) ──────────────────────────────
/**
 * "4 conversations · all views" — and, when the server's scan truncated,
 * "· showing the most recent matches" instead of pretending completeness.
 *
 * Null everywhere the line would lie or duplicate: before results exist, and
 * for zero rows (the no-matches empty state carries that message, echoing
 * the query — one message per fact).
 */
export function searchScopeLine(state) {
  if (!state || state.phase !== 'results') return null
  const n = Array.isArray(state.rows) ? state.rows.length : 0
  if (n === 0) return null
  const base = `${n} conversation${n === 1 ? '' : 's'} · all views`
  return state.searchPartial ? `${base} · showing the most recent matches` : base
}

// ── Empty & error copy ──────────────────────────────────────────────
/**
 * Echo the operator's own words back — it proves the search was HEARD, which
 * matters because FTS stopword behaviour means a real search can legitimately
 * find nothing while looking exactly like one that never ran (the web
 * MailList carries the same rule).
 */
export function noMatchesCopy(query) {
  const q = String(query || '').trim()
  return {
    title: q ? `No mail matches “${q}”.` : 'No mail matches that search.',
    body: 'Try different words — search covers subjects, senders and the text of every message, in every view.',
  }
}

/** The house rule in words: a failure never wears an empty state's clothes. */
export const SEARCH_ERROR_COPY = Object.freeze({
  title: 'Couldn’t search your mail',
  body: 'This is a connection problem, not an empty result. Check the connection and try again.',
  retry: 'Try again',
})

// ── Highlight splitting (mockup §03, callout 1) ─────────────────────

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Split `text` into segments for rendering, marking every case-insensitive
 * occurrence of any whitespace-separated query term. The matched slice keeps
 * its ORIGINAL casing (it is the text, re-painted — never the query echoed).
 *
 * Rules, each of which a test pins:
 *   • terms sort longest-first before joining into one alternation, because
 *     JS regex alternation takes the FIRST branch that matches at a position
 *     — "free freeze" must mark the whole of "Freeze", not "Free" + orphan;
 *   • terms are regex-escaped: the query is text, not syntax;
 *   • duplicate terms collapse (case-insensitively);
 *   • segments reassemble the input exactly, with no empty segments.
 *
 * @param {string|null|undefined} text
 * @param {string|null|undefined} query
 * @returns {{ text: string, match: boolean }[]}  [] when there is no text
 */
export function splitHighlight(text, query) {
  if (text == null || text === '') return []
  const s = String(text)

  const seen = new Set()
  const terms = []
  for (const t of String(query || '').trim().split(/\s+/)) {
    if (!t) continue
    const key = t.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    terms.push(t)
  }
  if (!terms.length) return [{ text: s, match: false }]

  terms.sort((a, b) => b.length - a.length)
  const re = new RegExp(terms.map(escapeRegExp).join('|'), 'gi')

  const out = []
  let last = 0
  let m
  while ((m = re.exec(s)) !== null) {
    // m[0] is never empty: every term has length ≥ 1, so lastIndex advances.
    if (m.index > last) out.push({ text: s.slice(last, m.index), match: false })
    out.push({ text: m[0], match: true })
    last = m.index + m[0].length
  }
  if (last < s.length) out.push({ text: s.slice(last), match: false })
  return out
}
