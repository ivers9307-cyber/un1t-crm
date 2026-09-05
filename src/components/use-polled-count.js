'use client'

// Shared badge-count poller (extracted from Sidebar so the
// Communications tab strip can show the same unread count on its Inbox
// tab). Expects the { success, data: { count } } envelope; keeps the
// last good count through network blips; refreshes on window focus.
//
// MAIL-PERF.1 — the clock no longer lives here. Every call used to own a
// setInterval + focus listener, so the sidebar badge and the hub tab strip
// each polled the same count URL on their own timer, hidden tab or not. The
// hook now subscribes through poll-store.js: N readers of one URL share ONE
// visibility-gated request per cadence, a late joiner is handed the last
// good value at once, and a sign-out halts the store (see that file for the
// module-state-survives-signOut trap it exists for). Same return contract —
// a number, 0 while disabled.

import { useEffect, useState } from 'react'
import { subscribePolledCount } from './poll-store'

export function usePolledCount({ enabled, url }) {
  const [count, setCount] = useState(0)
  useEffect(() => {
    if (!enabled) { setCount(0); return undefined }
    return subscribePolledCount(url, (value) => setCount(value))
  }, [enabled, url])
  return count
}
