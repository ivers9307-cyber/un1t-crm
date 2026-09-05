'use client'

// MAIL-PERF.1 — one poller per URL.
//
// THE PROBLEM. The sidebar's Messages badge (Sidebar.jsx) and the Communications
// tab strip (CommunicationsTabs.jsx) both read `/api/email/mail/count?scope=all`
// and `/api/whatsapp/unread-count` — the two costliest count endpoints — and
// each usePolledCount() call owned its own setInterval. Same URL, same 60s
// cadence, two clocks: every minute on a Communications page cost two requests
// for one number, and every badge stayed alive behind a hidden tab.
//
// THE SHAPE. A module-level Map of URL → { subscribers, lastValue, clock }.
// The first subscriber of a URL creates the entry and starts ONE
// visibility-gated clock (visible-interval.js); later subscribers share it
// and are handed the last good value at once; the last unsubscribe tears the
// entry down. N readers of a URL are one request per cadence, and a hidden tab
// is zero.
//
// 🔴 MODULE STATE SURVIVES A CLIENT-SIDE SIGN-OUT. `signOut({ scope: 'local' })`
// + `router.push('/login')` is a soft navigation — no reload, so this Map
// lives on. #1591 removed a per-tab signature memo for exactly this leak on
// the shared front-desk Mac. A count is not per-viewer-secret the way a
// signature is, but a signed-out screen must neither keep polling nor show
// the previous user's number, so the store listens to the browser client's
// `onAuthStateChange` (the event the app already emits — every sign-out path
// goes through supabase.auth.signOut on the @supabase/ssr singleton) and:
//   • user → null   (SIGNED_OUT)      halt every clock, drop every cached
//                                     value and any in-flight answer, tell
//                                     subscribers 0; keep the subscriber
//                                     sets (the components may stay mounted)
//   • null → user   (SIGNED_IN)       restart every entry that still has a
//                                     subscriber, with a fresh request
//   • user A → user B                 the same as the two above, in one step
//   • same user (TOKEN_REFRESHED, INITIAL_SESSION on a focus) — nothing.
// The FIRST report only records the user: a store that treated "no session
// yet" as a sign-out would never poll for a session the client is slow to
// read.
//
// PURE FACTORY + ONE SINGLETON. createPollStore() takes its fetcher, clock and
// visibility as inputs so poll-store.test.js can pin refcount + eviction with
// nothing real underneath; `pollStore` below is the instance the app uses,
// wired to fetch, document visibility and supabase auth on first use (client
// only — the module is imported by server-rendered components too).

import { createBrowserClient } from '@/lib/supabase'
import { createVisibleInterval, documentVisible } from './mail/visible-interval'

// AUDIT-13.G kept this module-private in use-polled-count.js; it moves here
// with the clock. (Unrelated same-named constants live in AcControlPanel.jsx
// and two mobile files.)
export const POLL_INTERVAL_MS = 60_000

/**
 * The count envelope every badge endpoint answers: { success, data: { count } }.
 * `undefined` means "keep the last good number" — a non-ok status or a
 * failed envelope is a blip, never a 0 (the EMAIL-TICKET-CLEANUP.2 posture).
 */
export async function fetchCount(url) {
  const r = await fetch(url, { cache: 'no-store' })
  if (!r.ok) return undefined
  const j = await r.json()
  if (!j?.success) return undefined
  return j.data?.count || 0
}

export function createPollStore({
  fetcher,
  intervalMs = POLL_INTERVAL_MS,
  isVisible = documentVisible,
  now = Date.now,
  setInterval: setI,
  clearInterval: clearI,
} = {}) {
  const entries = new Map()
  /** undefined = auth has not reported yet; null = signed out; string = user id */
  let userId
  let halted = false

  function load(entry) {
    const seq = ++entry.seq
    Promise.resolve()
      .then(() => fetcher(entry.url))
      .then((value) => {
        // Evicted, superseded by a later request, or halted while in flight:
        // the answer belongs to a screen that no longer exists.
        if (entries.get(entry.url) !== entry || seq !== entry.seq) return
        if (value === undefined) return // blip — keep the last good number
        entry.lastValue = value
        entry.subscribers.forEach((cb) => cb(value))
      })
      .catch(() => { /* network blip — keep last good count */ })
  }

  function makeEntry(url) {
    const entry = { url, subscribers: new Set(), lastValue: undefined, seq: 0, clock: null }
    entry.clock = createVisibleInterval({
      tick: () => load(entry),
      intervalMs,
      immediate: true,
      isVisible,
      now,
      setInterval: setI,
      clearInterval: clearI,
    })
    return entry
  }

  function dropEntry(entry) {
    entry.clock.stop()
    entry.seq += 1
    entries.delete(entry.url)
  }

  function haltAll() {
    halted = true
    entries.forEach((entry) => {
      entry.clock.stop()
      entry.seq += 1 // an in-flight answer for the old user is dropped
      entry.lastValue = undefined
      entry.subscribers.forEach((cb) => cb(0))
    })
  }

  function restartAll() {
    halted = false
    entries.forEach((entry) => {
      if (entry.subscribers.size === 0) { dropEntry(entry); return }
      entry.clock.start()
    })
  }

  return {
    /**
     * Subscribe `cb` to the count at `url`. Called at once with the last
     * good value when one exists. Returns the unsubscribe.
     */
    subscribe(url, cb) {
      let entry = entries.get(url)
      if (!entry) {
        entry = makeEntry(url)
        entries.set(url, entry)
        if (!halted) entry.clock.start()
      }
      entry.subscribers.add(cb)
      if (entry.lastValue !== undefined) cb(entry.lastValue)
      let active = true
      return () => {
        if (!active) return
        active = false
        entry.subscribers.delete(cb)
        if (entry.subscribers.size === 0 && entries.get(url) === entry) dropEntry(entry)
      }
    },

    /** Auth report: the current user's id, or null when signed out. */
    setAuth(nextId) {
      const prev = userId
      userId = nextId
      if (prev === undefined) return // first report only records
      if (nextId === prev) return    // TOKEN_REFRESHED / INITIAL_SESSION on focus
      if (nextId === null) { haltAll(); return }
      // Signing in after a halt: the halt already emptied everything.
      if (halted) { restartAll(); return }
      // A different user with no sign-out in between: whatever was cached
      // belonged to the last one.
      haltAll()
      restartAll()
    },

    onVisibilityChange() {
      entries.forEach((entry) => entry.clock.onVisibilityChange())
    },
    onFocus() {
      entries.forEach((entry) => entry.clock.onFocus())
    },

    /** Inspection seams. */
    size() {
      return entries.size
    },
    subscriberCount(url) {
      return entries.get(url)?.subscribers.size || 0
    },
    isHalted() {
      return halted
    },
    _resetForTests() {
      entries.forEach((entry) => entry.clock.stop())
      entries.clear()
      userId = undefined
      halted = false
    },
  }
}

// ── The app's instance ────────────────────────────────────────────────────

export const pollStore = createPollStore({ fetcher: fetchCount })

let wired = false
function ensureWired() {
  if (wired || typeof window === 'undefined') return
  wired = true
  document.addEventListener('visibilitychange', () => pollStore.onVisibilityChange())
  window.addEventListener('focus', () => pollStore.onFocus())
  // @supabase/ssr's createBrowserClient is a per-tab singleton, so this is
  // the SAME client every sign-out path calls signOut() on — its SIGNED_OUT
  // reaches here without any new event being invented. Best-effort: a
  // context with no client (env missing, test) still polls; it just cannot
  // evict on auth.
  try {
    createBrowserClient().auth.onAuthStateChange((_event, session) => {
      pollStore.setAuth(session?.user?.id ?? null)
    })
  } catch { /* no browser client here — polling still works, eviction does not */ }
}

/** What usePolledCount() calls: subscribe through the app's store. */
export function subscribePolledCount(url, cb) {
  ensureWired()
  return pollStore.subscribe(url, cb)
}
