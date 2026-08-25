'use client'

// Shared badge-count poller (extracted from Sidebar so the
// Communications tab strip can show the same unread count on its Inbox
// tab). Expects the { success, data: { count } } envelope; keeps the
// last good count through network blips; refreshes on window focus.

import { useEffect, useState } from 'react'

// AUDIT-13.G — module-private. It was exported and never imported;
// usePolledCount() below is the only reader. (Unrelated same-named
// constants live in AcControlPanel.jsx and two mobile files.)
const POLL_INTERVAL_MS = 60_000

export function usePolledCount({ enabled, url }) {
  const [count, setCount] = useState(0)
  useEffect(() => {
    if (!enabled) { setCount(0); return }
    let cancelled = false
    async function load() {
      try {
        const r = await fetch(url, { cache: 'no-store' })
        if (!r.ok) return
        const j = await r.json()
        if (!cancelled && j?.success) setCount(j.data?.count || 0)
      } catch { /* network blip — keep last good count */ }
    }
    load()
    const id = setInterval(load, POLL_INTERVAL_MS)
    const onFocus = () => load()
    window.addEventListener('focus', onFocus)
    return () => {
      cancelled = true
      clearInterval(id)
      window.removeEventListener('focus', onFocus)
    }
  }, [enabled, url])
  return count
}
