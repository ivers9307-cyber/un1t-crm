// SONOSLIVE.7 — the operator control strip. Talks to
// GET  /api/sonos/now-playing?schedule_id=<id>  (read their doc comment
//      before touching this file — the response shape here is matched
//      exactly, not guessed)
// POST /api/sonos/control  { schedule_id, action, value? }
//
// This is for one-off "nudge it right now" actions. It never writes to
// sonos_schedules — that stays ScheduleCard/ScheduleOverride's job — so a
// live change here simply persists until the schedule's next window
// boundary, same as any manual change made from the Sonos app itself.

'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { Loader2, AlertCircle, Play, Pause, SkipBack, SkipForward, Volume2, VolumeX } from 'lucide-react'
import { isPlaying, playbackLabel } from '@/lib/sonos/playback'

const POLL_MS = 10000
const VOLUME_STEP = 5
const DEBOUNCE_MS = 250

const REASON_COPY = {
  not_configured: "Sonos isn't configured on this deploy.",
  not_connected: 'Sonos is not connected.',
  refresh_failed: "Sonos didn't accept the stored connection — reconnect above.",
  db_error: 'Something went wrong reading the connection.',
  unreachable: 'Sonos is not answering right now.',
  no_group: "None of this schedule's speakers are online.",
}

function useNowPlaying(scheduleId) {
  const [state, setState] = useState(null)
  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/sonos/now-playing?schedule_id=${encodeURIComponent(scheduleId)}`)
      setState(await res.json())
    } catch {
      // A dropped poll is not worth surfacing — the next tick recovers.
    }
  }, [scheduleId])

  useEffect(() => {
    let timer = null
    const stop = () => { if (timer) { clearInterval(timer); timer = null } }
    const start = () => { if (!timer) timer = setInterval(load, POLL_MS) }

    const onVisibility = () => {
      if (document.visibilityState === 'hidden') { stop() }
      else { load(); start() }
    }

    load()
    start()
    document.addEventListener('visibilitychange', onVisibility)
    return () => { stop(); document.removeEventListener('visibilitychange', onVisibility) }
  }, [load])

  return [state, load]
}

// Coalesces held +/- presses into one relative call. Math.abs is
// deliberate — direction lives in the action name (volume_up/volume_down),
// and the server reads a negative step as a size, not an instruction to
// invert. Equal ups and downs cancel to 0 and send nothing.
function useVolumeNudge(send) {
  const pending = useRef(0)
  const timer = useRef(null)

  return useCallback((direction) => {
    pending.current += direction === 'up' ? VOLUME_STEP : -VOLUME_STEP
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      const total = pending.current
      pending.current = 0
      timer.current = null
      if (!total) return
      send(total > 0 ? 'volume_up' : 'volume_down', Math.abs(total))
    }, DEBOUNCE_MS)
  }, [send])
}

export default function SonosLiveControl({ scheduleId, favorites, editable }) {
  const [state, reload] = useNowPlaying(scheduleId)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [partialFailure, setPartialFailure] = useState(false)
  // Optimistic slider value while dragging/typing, reverted on request
  // failure. Null means "show the server's reported volume".
  const [pendingVolume, setPendingVolume] = useState(null)

  // Fresh server data replaces any stale optimistic value.
  useEffect(() => { setPendingVolume(null) }, [state?.volume])

  const send = useCallback(async (action, value) => {
    setBusy(true); setError(null); setPartialFailure(false)
    try {
      const res = await fetch('/api/sonos/control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ schedule_id: scheduleId, action, ...(value !== undefined ? { value } : {}) }),
      })
      const j = await res.json()
      if (!res.ok || j.success === false) {
        // volume_up/volume_down are relative — a failedGroups response
        // means some groups already moved, so retrying the whole action
        // would double-apply it there. Surface a partial failure instead
        // of an auto-retry; the operator decides what to do next.
        // applied/failedGroups only carry meaning when a schedule spans
        // more than one group — on the common single-group setup a failed
        // action comes back as applied: [] and failedGroups: [theOneGroup],
        // and "changed on some speakers but not all" would be false:
        // nothing changed. Gate on applied being non-empty; otherwise fall
        // through to the plain error message below, which is accurate.
        if (j.applied?.length > 0) setPartialFailure(true)
        throw new Error(j.error || 'That did not work')
      }
      await reload()
      // reload() may return the SAME volume (clamped, or a lagging read), in which case the [state.volume] effect never fires — clear explicitly.
      setPendingVolume(null)
    } catch (e) {
      setPendingVolume(null) // revert any optimistic value shown for this action
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }, [scheduleId, reload])

  const nudgeVolume = useVolumeNudge((action, step) => {
    const base = pendingVolume ?? state?.volume ?? 0
    const next = action === 'volume_up'
      ? Math.min(100, base + step)
      : Math.max(0, base - step)
    setPendingVolume(next) // optimistic; reverted in send() on failure
    send(action, step)
  })

  function commitVolumeSlider(e) {
    const value = Number(e.target.value)
    setPendingVolume(value)
    send('set_volume', value)
  }

  if (!state) {
    return (
      <div className="mt-3 border-t border-un1t-border/60 pt-3">
        <p className="text-xs font-semibold text-un1t-text mb-1.5">Live control</p>
        <p className="text-[11px] text-un1t-subtle inline-flex items-center gap-1.5">
          <Loader2 size={12} className="animate-spin" /> Checking what's playing…
        </p>
      </div>
    )
  }

  if (state.success === false || !state.live) {
    const reasonText = state.success === false
      ? (state.error || 'Something went wrong.')
      : (REASON_COPY[state.reason] || "Live control isn't available right now.")
    return (
      <div className="mt-3 border-t border-un1t-border/60 pt-3">
        <p className="text-xs font-semibold text-un1t-text mb-1.5">Live control</p>
        <p className="text-[11px] text-un1t-subtle">{reasonText}</p>
      </div>
    )
  }

  const disabled = busy || !editable
  const volumeUnreadable = state.volumeFailed
  const volumeFixed = !state.volumeFailed && state.fixedVolume
  const shownVolume = pendingVolume ?? state.volume ?? 0
  const label = playbackLabel(state.playbackState)

  return (
    <div className="mt-3 border-t border-un1t-border/60 pt-3">
      <p className="text-xs font-semibold text-un1t-text mb-1.5">Live control</p>

      {/* Readout */}
      <div className="mb-2">
        <p className="text-xs text-un1t-text font-medium">
          {label}
          {state.track?.name && <> — {state.track.name}</>}
          {state.track?.artist && <span className="text-un1t-subtle"> · {state.track.artist}</span>}
        </p>
        {state.metadataFailed ? (
          // A failed metadata read looks identical to "nothing playing" —
          // both leave track/source null. Say so, low-key: the transport
          // and volume controls still work, this is just a blank readout.
          <p className="text-[11px] text-un1t-subtle">Track info couldn&apos;t be read</p>
        ) : (
          state.source && <p className="text-[11px] text-un1t-subtle">{state.source}</p>
        )}
      </div>

      {/* Transport */}
      <div className="flex flex-wrap items-center gap-1.5">
        <button type="button" onClick={() => send('skip_previous')} disabled={disabled}
          title="Previous"
          className="inline-flex items-center justify-center h-7 w-7 rounded border border-un1t-border text-un1t-text hover:border-un1t-muted disabled:opacity-40">
          <SkipBack size={13} />
        </button>
        {isPlaying(state.playbackState) ? (
          <button type="button" onClick={() => send('pause')} disabled={disabled}
            title="Pause"
            className="inline-flex items-center justify-center h-7 w-7 rounded border border-un1t-border text-un1t-text hover:border-un1t-muted disabled:opacity-40">
            <Pause size={13} />
          </button>
        ) : (
          <button type="button" onClick={() => send('play')} disabled={disabled}
            title="Play"
            className="inline-flex items-center justify-center h-7 w-7 rounded border border-un1t-border text-un1t-text hover:border-un1t-muted disabled:opacity-40">
            <Play size={13} />
          </button>
        )}
        <button type="button" onClick={() => send('skip_next')} disabled={disabled}
          title="Next"
          className="inline-flex items-center justify-center h-7 w-7 rounded border border-un1t-border text-un1t-text hover:border-un1t-muted disabled:opacity-40">
          <SkipForward size={13} />
        </button>

        {/* Volume */}
        {volumeUnreadable ? (
          <span className="text-[11px] text-un1t-subtle ml-2 inline-flex items-center gap-1">
            <VolumeX size={13} /> Volume couldn&apos;t be read
          </span>
        ) : volumeFixed ? (
          <span className="text-[11px] text-un1t-subtle ml-2 inline-flex items-center gap-1">
            <Volume2 size={13} /> These speakers are set to a fixed volume
          </span>
        ) : (
          <div className="flex items-center gap-1.5 ml-2">
            <button type="button" onClick={() => nudgeVolume('down')} disabled={disabled}
              title="Volume down"
              className="inline-flex items-center justify-center h-7 w-7 rounded border border-un1t-border text-un1t-text hover:border-un1t-muted disabled:opacity-40">
              −
            </button>
            <input
              type="range" min="0" max="100" step="1"
              value={shownVolume}
              onChange={(e) => setPendingVolume(Number(e.target.value))}
              onMouseUp={commitVolumeSlider}
              onTouchEnd={commitVolumeSlider}
              onKeyUp={commitVolumeSlider}
              disabled={disabled}
              className="w-20 accent-un1t-text disabled:opacity-40"
            />
            <span className="tabular-nums w-7 text-[11px] text-un1t-subtle text-right">{shownVolume}</span>
            <button type="button" onClick={() => nudgeVolume('up')} disabled={disabled}
              title="Volume up"
              className="inline-flex items-center justify-center h-7 w-7 rounded border border-un1t-border text-un1t-text hover:border-un1t-muted disabled:opacity-40">
              +
            </button>
          </div>
        )}
      </div>

      {/* Favourites */}
      {favorites.length > 0 && (
        <label className="mt-2 text-[11px] text-un1t-subtle inline-flex items-center gap-1.5">
          Play favourite
          <select
            value=""
            onChange={(e) => { if (e.target.value) send('load_favorite', e.target.value) }}
            disabled={disabled}
            className="rounded border border-un1t-border bg-un1t-bg px-2 py-1 text-un1t-text disabled:opacity-40"
          >
            <option value="">Choose…</option>
            {favorites.map((f) => (
              <option key={f.id} value={f.id}>{f.name || f.id}</option>
            ))}
          </select>
        </label>
      )}

      {partialFailure && (
        <p className="mt-1.5 text-[11px] text-amber-700 inline-flex items-center gap-1">
          <AlertCircle size={12} /> Changed on some speakers but not all — check before trying again.
        </p>
      )}
      {error && !partialFailure && <p className="mt-1.5 text-[11px] text-red-700">{error}</p>}
    </div>
  )
}
