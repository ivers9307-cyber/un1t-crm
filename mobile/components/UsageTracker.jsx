// USAGE.1 — records which feature a signed-in staff member has open in the
// phone app, and for how long (design:
// docs/superpowers/specs/2026-10-26-app-usage-design.md). Renders nothing.
//
// Mounted in the staff layout only, so member screens never run it. Only the
// feature key leaves the phone (shared/usage-features), never the path. The
// clock stops when the app leaves the foreground; a new session starts when
// it comes back. Batches go to /api/usage/events every 60 s while open and
// when the app is backgrounded. Up to 60 s can be lost if the OS kills the
// app; accepted in the design.
//
// Masters and "view as" sessions are skipped here and again on the server,
// which is the real gate. Any failure is silent.

import { useEffect, useRef } from 'react'
import { AppState } from 'react-native'
import Constants from 'expo-constants'
import { usePathname } from 'expo-router'
import { createUsageTracker, flushUsage } from 'shared/usage-tracker'
import { featureForPhonePath } from 'shared/usage-features'
import { useAuth } from '../lib/auth-context'
import { api } from '../lib/api'

const FLUSH_MS = 60_000

async function sendBatch(batch) {
  const res = await api('/api/usage/events', { method: 'POST', body: batch })
  if (res?.success) return 'ok'
  // A 400 will never be taken; anything else (offline, 401 mid-refresh,
  // 5xx) is worth another try.
  return res?.status === 400 ? 'drop' : 'retry'
}

export default function UsageTracker() {
  const { session, profile, impersonatingFrom } = useAuth()
  const pathname = usePathname()
  const enabled = !!session && !!profile && profile.role !== 'master' && !impersonatingFrom
  const trackerRef = useRef(null)

  useEffect(() => {
    if (!enabled) return undefined
    let appVersion = null
    try { appVersion = Constants.expoConfig?.version || null } catch { /* ignore */ }
    const tracker = createUsageTracker({ platform: 'phone', appVersion })
    trackerRef.current = tracker
    const flush = () => { flushUsage(tracker, sendBatch, Date.now()) }

    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') tracker.resume(Date.now())
      else { tracker.pause(Date.now()); flush() }
    })
    const flusher = setInterval(() => {
      if (AppState.currentState === 'active') flush()
    }, FLUSH_MS)

    return () => {
      sub.remove()
      clearInterval(flusher)
      tracker.pause(Date.now())
      flush()
      trackerRef.current = null
    }
  }, [enabled])

  useEffect(() => {
    if (!enabled || !trackerRef.current) return
    trackerRef.current.screen(featureForPhonePath(pathname), Date.now())
  }, [enabled, pathname])

  return null
}
