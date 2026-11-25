// INBOXPERM.1 — one inbound message changes several rows (the conversation, the
// message, an approval) and each change reaches the browser as its own realtime
// event, so the unified inbox used to ask for the whole list once per event:
// five identical requests inside 50 ms were seen in production, and each list
// request now also reads the active set and the follow-up config.
//
// createListReloader wraps the inbox's list load:
//   request()  a realtime event: a TRAILING debounce (the WhatsApp inbox's
//              400 ms), capped by a maximum wait so a steady stream of events
//              still refreshes;
//   now()      manual refresh, the 60-second poll and the post-action
//              callbacks: immediate, and drops any pending debounce;
//   cancel()   unmount: drops the pending reload and any queued follow-up;
//   setLoad()  swaps the load function (a component's changes with its props).
// Both paths share one in-flight guard: never two list loads at once. A reload
// asked for while one runs becomes exactly ONE more run when it finishes.
//
// A load that never settles (a laptop that slept, a network switch) must not
// hold that guard for ever: a WATCHDOG frees it after WATCHDOG_MS, so the next
// poll, realtime reload or manual refresh runs a new load. The abandoned load
// is told it is stale: `load` receives `{ isCurrent }`, which turns false once
// the run is abandoned, cancelled or superseded, and a load that checks it
// before it sets state can never overwrite a newer one's result.

/** How long a burst of realtime events must be quiet before the list reloads (WAInbox's value). */
export const LIST_RELOAD_DEBOUNCE_MS = 400
/** The longest a stream of events can postpone the reload. */
export const LIST_RELOAD_MAX_WAIT_MS = 2000
/** How long one load may run before the in-flight guard is freed for the next one. */
export const LIST_RELOAD_WATCHDOG_MS = 30000

/**
 * @param {(ctx: { isCurrent: () => boolean }) => (Promise<unknown> | unknown)} initialLoad  the list load; its errors are swallowed here (it keeps the prior list on failure)
 * @param {{ debounceMs?: number, maxWaitMs?: number, watchdogMs?: number }} [opts]
 */
export function createListReloader(initialLoad, { debounceMs = LIST_RELOAD_DEBOUNCE_MS, maxWaitMs = LIST_RELOAD_MAX_WAIT_MS, watchdogMs = LIST_RELOAD_WATCHDOG_MS } = {}) {
  let load = initialLoad
  let timer = null
  let firstRequestAt = null // when the pending burst's first event arrived
  let running = false
  let again = false
  let runId = 0 // the run that holds the guard; bumped to abandon it
  let watchdog = null

  function release() {
    if (watchdog) clearTimeout(watchdog)
    watchdog = null
    running = false
    if (again) { again = false; run() }
  }

  function run() {
    if (running) { again = true; return }
    running = true
    const id = ++runId
    const isCurrent = () => runId === id
    // A load that has not settled by now is abandoned: free the guard.
    watchdog = setTimeout(() => { if (runId === id && running) { runId += 1; release() } }, watchdogMs)
    Promise.resolve()
      .then(() => load({ isCurrent }))
      .catch(() => {})
      .finally(() => { if (runId === id && running) release() })
  }

  function clearPending() {
    if (timer) clearTimeout(timer)
    timer = null
    firstRequestAt = null
  }

  return {
    request() {
      const now = Date.now()
      if (firstRequestAt === null) firstRequestAt = now
      if (timer) clearTimeout(timer)
      const wait = Math.min(debounceMs, Math.max(0, firstRequestAt + maxWaitMs - now))
      timer = setTimeout(() => { clearPending(); run() }, wait)
    },
    now() {
      clearPending()
      run()
    },
    cancel() {
      clearPending()
      again = false
      runId += 1 // whatever is in flight is stale now
      if (watchdog) clearTimeout(watchdog)
      watchdog = null
      running = false
    },
    setLoad(fn) { load = fn },
  }
}
