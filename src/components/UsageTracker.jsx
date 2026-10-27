'use client'

// USAGE.1 — records which feature a signed-in staff member has open in the
// web CRM, and for how long (design:
// docs/superpowers/specs/2026-10-26-app-usage-design.md). Renders nothing.
//
// Only the feature key leaves the browser (shared/usage-features.js), never
// the path. The clock stops when the tab is hidden or after 5 minutes with no
// input, timed at the last input (web-idle.js). Batches go to
// /api/usage/events every 60 s and when the page is hidden or closed
// (keepalive, so the last one survives navigation away).
//
// Masters, "view as" and support sessions are skipped here and again on the
// server, which is the real gate. Any failure is silent: usage recording
// must never show up in front of the person using the CRM.

import { useEffect, useRef } from 'react'
import { usePathname } from 'next/navigation'
import { createUsageTracker, flushUsage } from '@shared/usage-tracker'
import { featureForWebPath } from '@shared/usage-features'
import { createIdleWatch } from '@/lib/app-usage/web-idle'

const FLUSH_MS = 60_000
const TICK_MS = 15_000
const INPUT_THROTTLE_MS = 1000
const INPUT_EVENTS = ['pointerdown', 'keydown', 'scroll', 'touchstart', 'mousemove']

async function sendBatch(batch) {
  const res = await fetch('/api/usage/events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(batch),
    keepalive: true,
    credentials: 'same-origin',
  })
  if (res.ok) return 'ok'
  // 400: the server will never take this batch. Everything else (401 while a
  // session refreshes, 5xx) is worth another try.
  return res.status === 400 ? 'drop' : 'retry'
}

export function shouldTrackWebUser(user) {
  return !!user && !user.isMaster && !user.impersonatingFrom && !user.supportSession
}

export default function UsageTracker({ user }) {
  const pathname = usePathname()
  const enabled = shouldTrackWebUser(user)
  const trackerRef = useRef(null)

  useEffect(() => {
    if (!enabled) return undefined
    const tracker = createUsageTracker({ platform: 'web' })
    trackerRef.current = tracker
    const flush = () => { flushUsage(tracker, sendBatch, Date.now()) }

    const idle = createIdleWatch({
      onIdle: (atMs) => { tracker.pause(atMs); flush() },
      onActive: (atMs) => tracker.resume(atMs),
    })
    idle.input(Date.now())

    let lastInput = 0
    const onInput = () => {
      const now = Date.now()
      if (now - lastInput < INPUT_THROTTLE_MS) return
      lastInput = now
      idle.input(now)
    }
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') idle.hidden(Date.now())
      else idle.visible(Date.now())
    }
    const onPageHide = () => { tracker.pause(Date.now()); flush() }

    for (const e of INPUT_EVENTS) window.addEventListener(e, onInput, { passive: true, capture: true })
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pagehide', onPageHide)
    const tick = setInterval(() => idle.tick(Date.now()), TICK_MS)
    const flusher = setInterval(flush, FLUSH_MS)

    return () => {
      for (const e of INPUT_EVENTS) window.removeEventListener(e, onInput, { capture: true })
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pagehide', onPageHide)
      clearInterval(tick)
      clearInterval(flusher)
      tracker.pause(Date.now())
      flush()
      trackerRef.current = null
    }
  }, [enabled])

  useEffect(() => {
    if (!enabled || !trackerRef.current) return
    trackerRef.current.screen(featureForWebPath(pathname), Date.now())
  }, [enabled, pathname])

  return null
}
