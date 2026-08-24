// mobile/components/SonosControlCard.jsx
// SONOSMOB.4 / SONOSGRP.4 — live control for ONE Sonos target: the mobile
// twin of src/components/automations/SonosLiveControl.jsx. Read that file's
// header before changing this one — the now-playing response shape is
// matched exactly, not guessed.
//
// Dual target: callers pass exactly ONE of `schedule` (a sonos_schedules
// row — the per-schedule cards) or `group` (a raw household group from
// /api/sonos/household — the Live now cards, no schedule needed). Whichever
// is present names the wire target. Group ids are ephemeral, so a stale one
// answers reason/code `regrouped`; `onStale` fires at most ONCE per stale
// episode (re-armed by the next live poll) and the screen responds by
// re-running its load() so the cards heal to the new grouping.
//
// This is for one-off "nudge it right now" actions. It never writes to
// sonos_schedules and exposes no schedule editing — a change made here
// persists until the schedule's next window boundary, the same as a change
// made from the Sonos app itself.
//
// Volume is step buttons, not a slider: the app has no slider package and
// adding one is a native module (new binary through the stores, not an OTA).

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { View, Text, Pressable, ActivityIndicator } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useFocusEffect } from 'expo-router'
import { isPlaying, playbackLabel } from 'shared/sonos-playback'
import { getSonosNowPlaying, sendSonosAction } from '../lib/sonos-api'

const POLL_MS = 10_000
const VOLUME_STEP = 5
const DEBOUNCE_MS = 250

// Same copy as the web strip's REASON_COPY — keep them in step, except
// refresh_failed: there is no "above" on mobile, so it points at the web app.
const REASON_COPY = {
  not_configured: "Sonos isn't configured on this deploy.",
  not_connected: 'Sonos is not connected.',
  refresh_failed: "Sonos didn't accept the stored connection — reconnect on the web app.",
  db_error: 'Something went wrong reading the connection.',
  unreachable: 'Sonos is not answering right now.',
  no_group: "None of this schedule's speakers are online.",
  regrouped: 'The speakers regrouped — pulling the new groups…',
}

// Polls now-playing every POLL_MS while the screen is focused; stops on
// blur. Unlike the web strip, a dropped poll does not THROW here — api()
// returns a success:false envelope, tagged transport: true when api() minted
// it itself without a server answer (dropped fetch, non-JSON body) — so
// "not worth surfacing" has to be done by hand: once a live state exists, a
// tagged blip keeps it (the next tick recovers) instead of unmounting the
// controls to show "Network error" for ten seconds. A real server answer
// (401, 404, live:false — including a `regrouped` answer, which must replace
// a live state so the card shows the stale copy) carries no tag and still
// replaces it. A sequence number stops an older tick painting over
// a newer answer, which matters right after an action's reload().
function useNowPlaying(target, locationId) {
  const [state, setState] = useState(null)
  const seq = useRef(0)
  const load = useCallback(async () => {
    const n = ++seq.current
    // try/catch: authHeaders() → getSession() runs OUTSIDE api()'s own try
    // (same guard as `send` and the screen) — an uncaught rejection here
    // would leave "Checking what's playing…" painted forever.
    try {
      const r = await getSonosNowPlaying(target, locationId)
      if (n !== seq.current) return
      setState((prev) => (r?.transport && prev?.live ? prev : r))
    } catch {
      // Treat as a transport blip: keep whatever is painted; the next tick recovers.
    }
  }, [target, locationId])

  useFocusEffect(useCallback(() => {
    load()
    const timer = setInterval(load, POLL_MS)
    return () => clearInterval(timer)
  }, [load]))

  return [state, load]
}

// Coalesces held +/- presses into one relative call. Math.abs is
// deliberate — direction lives in the action name (volume_up/volume_down),
// and the server reads a negative step as a size. Equal ups and downs
// cancel to 0 and send nothing. The timer is deliberately NOT cleared on
// unmount — a press should still send; React ignores the late setState.
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

function IconButton({ icon, label, onPress, disabled }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      className="h-11 w-11 rounded-full border border-un1t-border items-center justify-center active:opacity-70 disabled:opacity-40"
    >
      <Ionicons name={icon} size={20} color="#111827" />
    </Pressable>
  )
}

export default function SonosControlCard({ schedule, group, favorites = [], locationId, onStale }) {
  // Exactly one of schedule/group. Memoised on the ids so `load`/`send`
  // keep their identity across renders (a fresh object every render would
  // re-subscribe the focus-effect poll each time).
  const scheduleId = schedule?.id
  const groupId = group?.id
  const target = useMemo(
    () => (scheduleId ? { scheduleId } : { groupId }),
    [scheduleId, groupId],
  )
  const [state, reload] = useNowPlaying(target, locationId)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [partialFailure, setPartialFailure] = useState(false)
  // Optimistic volume while nudging, reverted on failure. Null means "show
  // the server's reported volume".
  const [pendingVolume, setPendingVolume] = useState(null)

  // Fresh server data replaces any stale optimistic value.
  useEffect(() => { setPendingVolume(null) }, [state?.volume])

  // Debounce for onStale — same shape as the web strip's onRegrouped: the
  // poll keeps ticking every POLL_MS while the group id stays stale, and
  // each tick answers `regrouped` again — without this ref the screen would
  // reload on every tick. Fire at most once per stale episode; a later LIVE
  // poll (the card found its target again, e.g. after a remount with a
  // fresh id) re-arms it.
  const staleFired = useRef(false)

  const notifyStale = useCallback(() => {
    if (staleFired.current) return
    staleFired.current = true
    onStale?.()
  }, [onStale])

  useEffect(() => {
    if (!state) return
    if (state.success === true && state.live === false && state.reason === 'regrouped') {
      notifyStale()
    } else if (state.success === true && state.live) {
      staleFired.current = false
    }
  }, [state, notifyStale])

  // try/finally, not a bare await: authHeaders() → supabase.auth.getSession()
  // runs OUTSIDE api()'s own try, so if it ever rejects the only thing
  // standing between us and a forever-disabled card is the finally.
  const send = useCallback(async (action, value) => {
    setBusy(true); setError(null); setPartialFailure(false)
    try {
      const r = await sendSonosAction(target, action, value, locationId)
      if (!r.success) {
        // A stale group id: same episode-scoped notify as the poll path.
        if (r.code === 'regrouped') notifyStale()
        // volume_up/volume_down are relative — an `applied` list means some
        // groups already moved, so retrying the whole action would
        // double-apply it there. Say so instead of auto-retrying. On the
        // common single-group setup a failure comes back with applied: [],
        // so the plain error below is the accurate message.
        if (r.applied?.length > 0) setPartialFailure(true)
        setPendingVolume(null)
        setError(r.error || 'That did not work')
      } else {
        await reload()
        // reload() may return the SAME volume (clamped, or a lagging read), in which case the [state.volume] effect never fires — clear explicitly.
        setPendingVolume(null)
      }
    } catch (e) {
      setPendingVolume(null)
      setError(e?.message || 'That did not work')
    } finally {
      setBusy(false)
    }
  }, [target, locationId, reload, notifyStale])

  const nudgeVolume = useVolumeNudge((action, step) => {
    const base = pendingVolume ?? state?.volume ?? 0
    const next = action === 'volume_up' ? Math.min(100, base + step) : Math.max(0, base - step)
    setPendingVolume(next)
    send(action, step)
  })

  return (
    <View className="bg-un1t-surface border border-un1t-border rounded-2xl p-4">
      <Text className="text-base font-semibold text-un1t-text">
        {schedule?.name || group?.name || 'Studio music'}
      </Text>
      {group ? (
        <Text className="text-xs text-un1t-subtle">
          {group.playerIds?.length ?? 0} speaker{(group.playerIds?.length ?? 0) === 1 ? '' : 's'}
        </Text>
      ) : null}

      {!state ? (
        <View className="flex-row items-center mt-2">
          <ActivityIndicator color="#94A3B8" />
          <Text className="text-xs text-un1t-subtle ml-2">Checking what&apos;s playing…</Text>
        </View>
      ) : state.success === false || !state.live ? (
        <Text className="text-sm text-un1t-subtle mt-2">
          {state.success === false
            ? (state.error || 'Something went wrong.')
            : (REASON_COPY[state.reason] || "Live control isn't available right now.")}
        </Text>
      ) : (
        <LiveControls
          state={state}
          favorites={favorites}
          busy={busy}
          pendingVolume={pendingVolume}
          onSend={send}
          onNudge={nudgeVolume}
        />
      )}

      {partialFailure && (
        <View className="flex-row items-start mt-3">
          <Ionicons name="alert-circle-outline" size={14} color="#B45309" style={{ marginTop: 2 }} />
          <Text className="text-xs text-amber-700 ml-1.5 flex-1">
            Changed on some speakers but not all — check before trying again.
          </Text>
        </View>
      )}
      {error && !partialFailure && (
        <Text className="text-xs text-red-700 mt-3">{error}</Text>
      )}
    </View>
  )
}

function LiveControls({ state, favorites, busy, pendingVolume, onSend, onNudge }) {
  const volumeUnreadable = state.volumeFailed
  // fixedVolume only means something when the volume read succeeded —
  // check volumeFailed first.
  const volumeFixed = !state.volumeFailed && state.fixedVolume
  const shownVolume = pendingVolume ?? state.volume ?? 0

  return (
    <View>
      {/* Readout */}
      <Text className="text-sm text-un1t-text mt-1">
        {playbackLabel(state.playbackState)}
        {state.track?.name ? ` — ${state.track.name}` : ''}
        {state.track?.artist ? <Text className="text-un1t-subtle"> · {state.track.artist}</Text> : null}
      </Text>
      {state.metadataFailed ? (
        // A failed metadata read looks identical to "nothing playing" —
        // both leave track/source null. Say so; the controls still work.
        <Text className="text-xs text-un1t-subtle">Track info couldn&apos;t be read</Text>
      ) : state.source ? (
        <Text className="text-xs text-un1t-subtle">{state.source}</Text>
      ) : null}

      {/* Transport */}
      <View className="flex-row items-center justify-center gap-4 mt-4">
        <IconButton icon="play-skip-back" label="Previous" onPress={() => onSend('skip_previous')} disabled={busy} />
        {isPlaying(state.playbackState) ? (
          <IconButton icon="pause" label="Pause" onPress={() => onSend('pause')} disabled={busy} />
        ) : (
          <IconButton icon="play" label="Play" onPress={() => onSend('play')} disabled={busy} />
        )}
        <IconButton icon="play-skip-forward" label="Next" onPress={() => onSend('skip_next')} disabled={busy} />
      </View>

      {/* Volume */}
      <View className="flex-row items-center justify-center mt-4">
        {volumeUnreadable ? (
          <View className="flex-row items-center">
            <Ionicons name="volume-mute-outline" size={16} color="#94A3B8" />
            <Text className="text-xs text-un1t-subtle ml-1.5">Volume couldn&apos;t be read</Text>
          </View>
        ) : volumeFixed ? (
          <View className="flex-row items-center">
            <Ionicons name="volume-medium-outline" size={16} color="#94A3B8" />
            <Text className="text-xs text-un1t-subtle ml-1.5">These speakers are set to a fixed volume</Text>
          </View>
        ) : (
          <View className="flex-row items-center gap-4">
            <IconButton icon="remove" label="Volume down" onPress={() => onNudge('down')} disabled={busy} />
            <View
              className="flex-row items-center w-16 justify-center"
              accessible
              accessibilityLabel={`Volume ${shownVolume}`}
            >
              <Ionicons name="volume-medium-outline" size={16} color="#94A3B8" />
              <Text className="text-base text-un1t-text ml-1.5 tabular-nums">{shownVolume}</Text>
            </View>
            <IconButton icon="add" label="Volume up" onPress={() => onNudge('up')} disabled={busy} />
          </View>
        )}
      </View>

      {/* Favourites — chips, not a picker: RN has no native <select>, and a
          two-deep modal is worse than a wrap of pills for a studio's handful. */}
      {favorites.length > 0 && (
        <View className="mt-4">
          <Text className="text-[11px] uppercase tracking-wider text-un1t-subtle mb-2">Play favourite</Text>
          <View className="flex-row flex-wrap gap-2">
            {favorites.map((f) => (
              <Pressable
                key={f.id}
                onPress={() => onSend('load_favorite', f.id)}
                disabled={busy}
                accessibilityRole="button"
                accessibilityLabel={`Play ${f.name || f.id}`}
                className="px-3 py-1.5 rounded-full border border-un1t-border bg-un1t-bg active:opacity-70 disabled:opacity-40"
              >
                <Text className="text-sm text-un1t-text">{f.name || f.id}</Text>
              </Pressable>
            ))}
          </View>
        </View>
      )}
    </View>
  )
}
