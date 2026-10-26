// USAGE.1 — the app usage tracker: a pure state machine shared by the phone
// app and the web CRM. It knows nothing of React, AppState, the DOM or the
// network; the platform wrappers feed it events and post what it drains.
//
//   screen(feature, now)  the user is looking at `feature` (a
//                         shared/usage-features.js key; anything else is
//                         filed under 'other')
//   pause(now)            app backgrounded / tab hidden / idle: the session
//                         ends here and its final batch goes on the queue
//   resume(now)           back in use: a NEW session starts here
//   drain(now)            the live session's batch so far, or null
//   requeue(batch)        a batch to (re)send; at most 10 are kept
//   requeueFront(batches) put failed batches back ahead of newer ones
//   takePending()         empty the queue and return it, oldest first
//
// Ids are minted here (newId), so a batch that is re-sent after a network
// blip upserts the same rows on the server instead of adding new ones. The
// open visit goes out with "ended now" on every drain and again, same id,
// with a later end on the next one; the server keeps the latest.

import { isUsageFeature } from './usage-features.js'

export const MAX_PENDING_BATCHES = 10
export const MIN_VISIT_MS = 2000
export const MAX_VISIT_MS = 4 * 3600 * 1000

const iso = (ms) => new Date(ms).toISOString()

/**
 * A v4-shaped uuid for a session or visit id (the route pins the shape with
 * uuidLike). Hermes ships no crypto global, hence the Math.random fallback
 * (the same trade as mobile/lib/email-api.js draftUuid): the id carries no
 * authority, and a collision with someone else's session is refused by the
 * route's owner check.
 */
export function usageId() {
  const c = globalThis.crypto
  if (c?.randomUUID) return c.randomUUID()
  const bytes = new Uint8Array(16)
  if (c?.getRandomValues) c.getRandomValues(bytes)
  else for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256)
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function createUsageTracker({
  platform,
  appVersion = null,
  newId = usageId,
  minVisitMs = MIN_VISIT_MS,
  maxVisitMs = MAX_VISIT_MS,
}) {
  let feature = null // the feature on screen, kept across a pause
  let paused = false
  let session = null // { id, startMs }
  let open = null // { id, feature, startMs }
  let closed = [] // finished visits not yet drained
  let pending = []

  const capEnd = (startMs, endMs) => Math.min(endMs, startMs + maxVisitMs)

  function toVisit(v, endMs) {
    return { id: v.id, feature: v.feature, started_at: iso(v.startMs), ended_at: iso(capEnd(v.startMs, endMs)) }
  }

  function closeOpen(nowMs) {
    if (!open) return
    if (nowMs - open.startMs >= minVisitMs) closed.push({ ...open, endMs: capEnd(open.startMs, nowMs) })
    open = null
  }

  function openVisit(f, nowMs) {
    // A bounce (A → B for under 2 s → A) carries on the A visit rather than
    // starting a new one, as long as that visit has not been sent yet.
    const last = closed[closed.length - 1]
    if (last && last.feature === f && nowMs - last.endMs < minVisitMs) {
      closed.pop()
      open = { id: last.id, feature: f, startMs: last.startMs }
      return
    }
    open = { id: newId(), feature: f, startMs: nowMs }
  }

  function batch(endMs) {
    const visits = closed.map((v) => toVisit(v, v.endMs))
    if (open && endMs - open.startMs >= minVisitMs) visits.push(toVisit(open, endMs))
    return {
      session: { id: session.id, platform, app_version: appVersion, started_at: iso(session.startMs), ended_at: iso(endMs) },
      visits,
    }
  }

  function startSession(nowMs) {
    session = { id: newId(), startMs: nowMs }
    closed = []
    if (feature) openVisit(feature, nowMs)
  }

  const cap = () => {
    if (pending.length > MAX_PENDING_BATCHES) pending = pending.slice(-MAX_PENDING_BATCHES)
  }
  function requeue(b) {
    pending.push(b)
    cap()
  }
  // Batches that failed to send go back AHEAD of anything queued while they
  // were in flight, so one session's batches always land oldest first.
  function requeueFront(batches) {
    pending = [...batches, ...pending]
    cap()
  }

  return {
    screen(f, nowMs) {
      const key = isUsageFeature(f) ? f : 'other'
      feature = key
      if (paused) return
      if (!session) {
        startSession(nowMs)
        return
      }
      if (open && open.feature === key) return
      closeOpen(nowMs)
      openVisit(key, nowMs)
    },

    pause(nowMs) {
      if (paused) return
      paused = true
      if (!session) return
      closeOpen(nowMs)
      requeue(batch(nowMs))
      session = null
      closed = []
    },

    resume(nowMs) {
      if (!paused) return
      paused = false
      if (feature) startSession(nowMs)
    },

    drain(nowMs) {
      if (!session) return null
      const b = batch(nowMs)
      closed = []
      return b
    },

    requeue,
    requeueFront,

    pending() {
      return [...pending]
    },

    takePending() {
      const out = pending
      pending = []
      return out
    },
  }
}

/**
 * Send everything the tracker holds: queued batches oldest first, then the
 * live session's batch so far. `send(batch)` answers 'ok' (recorded),
 * 'drop' (the server will never take it: a 400, or not recorded for this
 * user) or 'retry' (offline, 401 mid-refresh, 5xx). A throw is 'retry'. The
 * first 'retry' stops the loop and keeps that batch and everything after it,
 * so batches for one session always land in order (the server keeps the
 * latest end time, and an older batch landing last would roll it back).
 * One flush at a time per tracker.
 */
const flushing = new WeakSet()
export async function flushUsage(tracker, send, nowMs) {
  if (flushing.has(tracker)) return
  flushing.add(tracker)
  try {
    const live = tracker.drain(nowMs)
    if (live) tracker.requeue(live)
    const queue = tracker.takePending()
    for (let i = 0; i < queue.length; i++) {
      let outcome
      try {
        // The device clock at send time: the server shifts the batch by
        // its own now minus this, so a fast or slow clock still lands right.
        outcome = await send({ ...queue[i], sent_at: new Date().toISOString() })
      } catch {
        outcome = 'retry'
      }
      if (outcome === 'retry') {
        tracker.requeueFront(queue.slice(i))
        return
      }
    }
  } finally {
    flushing.delete(tracker)
  }
}
