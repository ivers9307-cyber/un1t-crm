'use client'

// MAIL-PERF.1 — the React seam over visible-interval.js.
//
// Every Mail poller (list, thread, tiles in MailSurface; the badge store for
// the sidebar and hub tabs goes through poll-store.js instead) used to be its
// own `setInterval` + `focus` listener with no idea whether anyone was
// looking. This hook is the ONE place that wiring lives: hidden tab → the
// clock stops; visible again → one immediate refresh, then the cadence from
// now; window focus → a refresh (deduped against the visibility resume).
//
// THIN ON PURPOSE. jsdom cannot prove visibility behaviour, so the state
// machine is the injectable controller (tested in visible-interval.test.js)
// and this hook only binds it to `document`/`window` and to React's lifecycle.
// The callback is read through a ref so a new identity (e.g. refreshList
// re-created on a scope change) does not restart the clock — the callers'
// own "refetch now on scope change" effects already cover that moment.

import { useEffect, useRef } from 'react'
import { createVisibleInterval, documentVisible } from './visible-interval'

/**
 * @param {() => void} fn          the poll
 * @param {number} intervalMs      cadence while visible; <= 0 disables
 * @param {object} [opts]
 * @param {boolean} [opts.enabled=true]
 * @param {boolean} [opts.immediate=false]  tick on mount when visible
 */
export function useVisibleInterval(fn, intervalMs, { enabled = true, immediate = false } = {}) {
  const fnRef = useRef(fn)
  useEffect(() => { fnRef.current = fn }, [fn])

  useEffect(() => {
    if (!enabled || !(intervalMs > 0)) return undefined
    const ctl = createVisibleInterval({
      tick: () => { fnRef.current?.() },
      intervalMs,
      immediate,
      isVisible: documentVisible,
    })
    const onVisibility = () => ctl.onVisibilityChange()
    const onFocus = () => ctl.onFocus()
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('focus', onFocus)
    ctl.start()
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('focus', onFocus)
      ctl.stop()
    }
  }, [enabled, intervalMs, immediate])
}
