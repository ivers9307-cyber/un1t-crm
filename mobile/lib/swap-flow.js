// mobile/lib/swap-flow.js
//
// COVERLOOP.2 — WHEN the swap confirm sheet may open. Pure (no React Native),
// so it is vitest-testable; components/dashboard/PersonalDashboard.jsx only
// applies the step it returns.
//
// Why this exists: the targeted-swap flow is picker <Modal> -> confirm <Modal>.
// iOS presents a Modal the moment `visible` flips, with no queue and no retry,
// and UIKit refuses a present while another view controller is still animating
// out. Closing the picker and opening the sheet in the same commit therefore
// showed NOTHING on iOS, and left the sheet's state set with no sheet on
// screen. So on iOS the pick is parked (`pending`, a ref in the component)
// until the picker's <Modal onDismiss> fires, which iOS does from the dismiss
// completion block. Android never fires onDismiss and has no such restriction,
// so it opens at once.
//
// The flow can never wedge: every entry point ('start', 'post') discards
// whatever an earlier run left behind, and a dismiss with nothing parked is a
// no-op (that is what cancelling the picker looks like on iOS).
//
// Events:
//   'start'     the coach tapped "Ask a coach to cover…" (about to open the picker)
//   'post'      the coach tapped "Post for swap" (no picker; `picked` = { shift, coach: null })
//   'pick'      a coach was chosen in the picker (`picked` = { shift, coach })
//   'cancel'    the picker was closed without a pick
//   'dismissed' the picker's Modal finished dismissing (iOS only)
//
// Returns { action, pending, request }:
//   action   'open_confirm' | 'wait_for_dismiss' | 'reset' | 'noop'
//   pending  what the component's ref must hold next (always assign it)
//   request  the { shift, coach } to open the sheet with (open_confirm only)
//   'reset' additionally means: clear the confirm-sheet state.

const usable = (r) => (r && r.shift ? r : null)

export function nextSwapFlowStep({ event, platform, pickerVisible, pending, picked } = {}) {
  const none = { action: 'noop', pending: null, request: null }
  const reset = { action: 'reset', pending: null, request: null }

  switch (event) {
    case 'start':
    case 'cancel':
      return reset

    case 'post': {
      const request = usable(picked)
      return request ? { action: 'open_confirm', pending: null, request } : reset
    }

    case 'pick': {
      const request = usable(picked)
      if (!request) return reset
      if (platform === 'ios') return { action: 'wait_for_dismiss', pending: request, request: null }
      return { action: 'open_confirm', pending: null, request }
    }

    case 'dismissed': {
      const request = usable(pending)
      // Never over a picker that is (again) on screen: that present would be
      // refused too. The parked pick is dropped either way.
      if (!request || pickerVisible) return none
      return { action: 'open_confirm', pending: null, request }
    }

    default:
      return none
  }
}

/**
 * A synchronous in-flight latch. React state read from a render closure is
 * stale until the re-render, so `if (sending) return` lets a second tap through
 * and POSTs twice (the server's one-open-swap index then 409s the second, and
 * the coach sees an error straight after a success). Hold one of these in a
 * ref: begin() is true exactly once until end().
 */
export function createInFlightGuard() {
  let busy = false
  return {
    begin() {
      if (busy) return false
      busy = true
      return true
    },
    end() { busy = false },
    get busy() { return busy },
  }
}
