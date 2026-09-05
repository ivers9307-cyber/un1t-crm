// MAIL-PERF.1 — the visibility-gated poll clock, as a pure controller.
//
// WHY A CONTROLLER AND NOT JUST `if (document.hidden) return` IN THE TICK.
// The Mail audit counted eight pollers across the Mail surface (list, thread,
// tiles, sidebar badge, hub tabs) and none of them stopped when the tab was
// hidden — a Mail tab left open behind a spreadsheet kept every one of them
// firing all day. WAInbox.jsx:331 skips the fetch while hidden, which halves
// the cost but keeps the clock running and, worse, gives the operator a stale
// screen for up to a full cadence after they come back. This controller does
// both halves: HIDDEN → the timer is torn down (no clock, no fetch);
// VISIBLE AGAIN → one immediate tick, then the cadence restarts from now.
//
// PURE ON PURPOSE. jsdom cannot see real visibility, so the browser wiring
// (document `visibilitychange`, window `focus`) stays in the thin hook
// (use-visible-interval.js) and the shared store (poll-store.js), and THIS
// module is the state machine — every input (visibility, clock, timers) is
// injected, so the tests pin the transitions rather than the DOM.
//
// FOCUS IS KEPT, AND DEDUPED. The old pollers refreshed on window `focus`;
// that stays (a click back into the window is still "I'm looking now"). But
// a tab switch fires BOTH `visibilitychange` and `focus` within the same
// frame, which would be two fetches for one return — so a focus landing
// within RESUME_DEDUPE_MS of a visibility resume is dropped. A focus with no
// preceding resume (window-to-window, same tab) always ticks.

/** A focus this soon after a visibility resume is the same "return". */
export const RESUME_DEDUPE_MS = 1000

/** Browser default for `isVisible`: undefined visibilityState reads as visible. */
export function documentVisible() {
  if (typeof document === 'undefined') return true
  return document.visibilityState !== 'hidden'
}

/**
 * @param {object} opts
 * @param {() => void} opts.tick           what a poll does
 * @param {number}     opts.intervalMs     cadence while visible
 * @param {boolean}    [opts.immediate]    tick on start() when visible (a
 *                                         hidden start defers that first
 *                                         tick to the resume)
 * @param {() => boolean} [opts.isVisible]
 * @param {() => number}  [opts.now]
 * @param {Function}   [opts.setInterval]
 * @param {Function}   [opts.clearInterval]
 */
export function createVisibleInterval({
  tick,
  intervalMs,
  immediate = false,
  isVisible = documentVisible,
  now = Date.now,
  setInterval: setI,
  clearInterval: clearI,
}) {
  // Resolved at CALL time, not capture time — a test's fake timers (or any
  // later patch of the globals) must reach a controller built before them.
  const schedule = (...a) => (setI || globalThis.setInterval)(...a)
  const cancel = (...a) => (clearI || globalThis.clearInterval)(...a)
  let timer = null
  let running = false
  let lastResumeAt = -Infinity

  function arm() {
    if (timer === null) timer = schedule(fire, intervalMs)
  }
  function disarm() {
    if (timer !== null) {
      cancel(timer)
      timer = null
    }
  }
  function fire() {
    if (!running) return
    // Belt and braces — a hidden tab whose visibilitychange was missed must
    // still not fetch (the WAInbox posture), and it drops its clock here.
    if (!isVisible()) { disarm(); return }
    tick()
  }

  /** Immediate tick, cadence restarts from now. */
  function resume() {
    lastResumeAt = now()
    disarm()
    tick()
    arm()
  }

  return {
    start() {
      if (running) return
      running = true
      if (!isVisible()) return // the resume is the first tick
      if (immediate) tick()
      arm()
    },
    stop() {
      running = false
      disarm()
    },
    onVisibilityChange() {
      if (!running) return
      if (isVisible()) resume()
      else disarm()
    },
    onFocus() {
      if (!running || !isVisible()) return
      if (now() - lastResumeAt < RESUME_DEDUPE_MS) return
      tick()
    },
    /** Test/inspection seam — is a clock armed right now? */
    isArmed() {
      return timer !== null
    },
    isRunning() {
      return running
    },
  }
}
