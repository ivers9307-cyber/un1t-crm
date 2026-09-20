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
//   'fallback_elapsed' PICKER_DISMISS_FALLBACK_MS passed since an iOS pick
//               (see createSwapFlow: the same decision as 'dismissed')
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

    case 'dismissed':
    case 'fallback_elapsed': {
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

// iOS's modal dismiss animation is roughly 300-500 ms; by 700 a present is safe.
export const PICKER_DISMISS_FALLBACK_MS = 700

/**
 * The flow's one holder of state: the parked pick and the fallback timer.
 * Lives in a ref in PersonalDashboard.jsx; no React Native in here, so the
 * timer wiring is tested with fake timers.
 *
 * WHY BOTH onDismiss AND A TIMER — do not "simplify" one away: onDismiss is
 * the exact moment iOS allows the next present, but if a React Native build
 * never fires it the confirm sheet never opens and the feature is dead on iOS;
 * the timer alone would be a guess at an animation length.
 *
 * Exactly-once: whichever of the two arrives first CONSUMES the parked pick
 * (pending is nulled before the sheet is opened), and EVERY dispatch disarms
 * the timer first, so the loser finds nothing parked and does nothing. A
 * fresh start, a cancel, the confirm sheet closing and dispose() (unmount) all
 * disarm it too, so it cannot fire into a stale or unmounted screen or open a
 * sheet after the coach backed out. Silent by design: nothing is logged.
 */
export function createSwapFlow({
  platform, onOpenConfirm, onReset,
  setTimer = setTimeout, clearTimer = clearTimeout, delayMs = PICKER_DISMISS_FALLBACK_MS,
} = {}) {
  let pending = null
  let timer = null
  // Counts OPEN REQUESTS. The component keys <SwapConfirmSheet> on it, so every
  // request REMOUNTS the sheet: if iOS ever refused a present (say at the
  // fallback), re-setting the same state would change nothing and the flow
  // could not recover; a new key presents a fresh Modal. Never reset.
  let openSeq = 0

  function disarm() {
    if (timer !== null) { clearTimer(timer); timer = null }
  }

  function dispatch(event, { picked, pickerVisible = false } = {}) {
    disarm()
    const step = nextSwapFlowStep({ event, platform, pickerVisible, pending, picked })
    pending = step.pending
    if (step.action === 'wait_for_dismiss') {
      // Only an iOS pick gets here, so Android never arms a timer.
      timer = setTimer(() => { timer = null; dispatch('fallback_elapsed') }, delayMs)
    } else if (step.action === 'open_confirm') {
      openSeq += 1
      onOpenConfirm?.(step.request, openSeq)
    } else if (step.action === 'reset') {
      onReset?.()
    }
    return step
  }

  return {
    dispatch,
    /** Unmount: disarm and drop the pick. Not terminal (dev double-mounts effects). */
    dispose() { disarm(); pending = null },
    get pending() { return pending },
  }
}

// The synchronous in-flight latch lives in ./in-flight-guard (one owner since
// LEAVEPHONE.1; the leave form uses it too). Re-exported so the swap flow's
// existing importers and tests keep working unchanged.
export { createInFlightGuard } from './in-flight-guard'
