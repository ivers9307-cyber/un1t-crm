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
//   cancel()   unmount: drops the pending reload and any queued follow-up.
// Both paths share one in-flight guard: never two list loads at once. A reload
// asked for while one runs becomes exactly ONE more run when it finishes.

/** How long a burst of realtime events must be quiet before the list reloads (WAInbox's value). */
export const LIST_RELOAD_DEBOUNCE_MS = 400
/** The longest a stream of events can postpone the reload. */
export const LIST_RELOAD_MAX_WAIT_MS = 2000

/**
 * @param {() => (Promise<unknown> | unknown)} load  the list load; its errors are swallowed here (it keeps the prior list on failure)
 * @param {{ debounceMs?: number, maxWaitMs?: number }} [opts]
 */
export function createListReloader(load, { debounceMs = LIST_RELOAD_DEBOUNCE_MS, maxWaitMs = LIST_RELOAD_MAX_WAIT_MS } = {}) {
  let timer = null
  let firstRequestAt = null // when the pending burst's first event arrived
  let running = false
  let again = false

  function run() {
    if (running) { again = true; return }
    running = true
    Promise.resolve()
      .then(load)
      .catch(() => {})
      .finally(() => {
        running = false
        if (again) { again = false; run() }
      })
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
    },
  }
}
