// LEAVEPHONE.1 — a synchronous in-flight latch for a submit button.
//
// React state read from a render closure is stale until the re-render, so
// `if (submitting) return` lets a second tap through and POSTs twice (for the
// leave form the server's overlap guard then 409s the second, and the coach
// sees an error straight after a success). Hold one of these in a useRef:
// begin() is true exactly once until end().
//
// Same shape as the latch COVERLOOP.2 adds to lib/swap-flow.js for the swap
// post; that PR was not on main when this was written. Once both are, one
// should re-export the other.
export function createInFlightGuard() {
  let busy = false
  function begin() {
    if (busy) return false
    busy = true
    return true
  }
  function end() { busy = false }
  return {
    begin,
    end,
    /**
     * PREFER THIS: take the latch, do the work, ALWAYS release. Everything
     * that can throw goes inside `work`, so a synchronous throw cannot strand
     * the latch. Resolves undefined, without calling `work`, when a run is
     * already in flight.
     */
    async run(work) {
      if (!begin()) return undefined
      try {
        return await work()
      } finally {
        end()
      }
    },
    get busy() { return busy },
  }
}
