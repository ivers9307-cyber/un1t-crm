// USAGE.1 — web idle detection for the app usage tracker, as a pure state
// machine (no DOM, no timers) so it can be tested without a browser.
//
// A web session ends when the tab is hidden, or after 5 minutes with no
// pointer, key, scroll or touch input. An idle session ends at the LAST
// INPUT, not when the timeout fires, so a tab left open on a desk never adds
// the 5 idle minutes to anyone's time (design: "idle web time ends at the
// last input").

export const WEB_IDLE_MS = 5 * 60_000

export function createIdleWatch({ idleMs = WEB_IDLE_MS, onIdle, onActive }) {
  let lastInput = null
  let idle = false
  let hidden = false

  return {
    input(nowMs) {
      if (hidden) return
      lastInput = nowMs
      if (idle) {
        idle = false
        onActive(nowMs)
      }
    },

    tick(nowMs) {
      if (hidden || idle || lastInput === null) return
      if (nowMs - lastInput > idleMs) {
        idle = true
        onIdle(lastInput)
      }
    },

    hidden(nowMs) {
      if (hidden) return
      hidden = true
      if (!idle) onIdle(nowMs)
      idle = true
    },

    visible(nowMs) {
      if (!hidden) return
      hidden = false
      idle = false
      lastInput = nowMs
      onActive(nowMs)
    },
  }
}
